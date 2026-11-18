// ==============================================================================
// LockaCourt (AratReserve) — HitPay Sandbox Webhook Handler
// File: supabase/functions/hitpay-webhook/handler.ts
//
// Security & Verification Pipeline:
//   1. Checks Stage 2 sandbox configuration (fails closed with 503 if unconfigured)
//   2. Reads exact raw request body (rejects legacy form-urlencoded callbacks)
//   3. Verifies Hitpay-Signature HMAC-SHA256 hex digest over rawBody BEFORE any
//      JSON parsing or provider_webhook_events insert/update/dedup lookup
//   4. Enforces Stage 2 sandbox isolation (rejects live env/flags/URLs/payloads)
//   5. Stores verified event in append-only provider_webhook_events inbox with
//      duplicate payload_hash conflict detection and lease management
//   6. Authoritatively re-queries GET /v1/payment-requests/{id} (captures) or
//      GET /v1/refund/{id} (refunds) on HitPay Sandbox and verifies booking
//      reference_code & unambiguous refund amounts BEFORE ledger settlement
// ==============================================================================

import {
  assertHitPayPhpCurrency,
  assertHitPaySandboxPayload,
  getHitPayPaymentRequestStatus,
  getHitPayRefundStatus,
  isHitPaySandboxCheckoutUrl,
  isHitPaySandboxConfigured,
  normalizeHitPayWebhook,
  parseHitPayDecimalAmount,
  resolveHitPaySandboxConfig,
  verifyHitPayWebhookSignatureAsync,
  HitPayConfigError,
  type HitPayFetchLike,
} from '../_shared/hitpay.ts';

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, hitpay-signature, hitpay-event-type, hitpay-event-object',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export interface HitPayWebhookDeps {
  supabaseAdmin: {
    from: (table: string) => any;
    rpc: (
      fn: string,
      params?: Record<string, unknown>
    ) => Promise<{ data: any; error: { message?: string; code?: string } | null }>;
  };
  env: Record<string, string | undefined>;
  fetchFn?: HitPayFetchLike;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function handleHitPayWebhookRequest(
  req: Request,
  deps: HitPayWebhookDeps
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return jsonResponse(
      {
        success: false,
        error:
          'Legacy form-urlencoded HitPay webhooks are rejected. Modern JSON dashboard webhooks with Hitpay-Signature header are required.',
      },
      400
    );
  }

  const env = deps.env || {};
  const fetchFn = deps.fetchFn || globalThis.fetch;

  // 1. Fail closed on sandbox configuration / live credentials / missing webhook salt or API key
  let config: ReturnType<typeof resolveHitPaySandboxConfig>;
  try {
    config = resolveHitPaySandboxConfig(env);
    if (!isHitPaySandboxConfigured(config)) {
      return jsonResponse(
        {
          success: false,
          status: 'provider_not_configured',
          code: 'provider_not_configured',
          provider_name: 'hitpay',
          is_ready: false,
          error:
            'provider_not_configured: HitPay sandbox API key or webhook signing secret is not configured.',
        },
        503
      );
    }
  } catch (cfgErr: unknown) {
    console.error('[hitpay-webhook] Sandbox config failure:', cfgErr);
    return jsonResponse(
      {
        success: false,
        error:
          cfgErr instanceof HitPayConfigError
            ? cfgErr.message
            : 'Invalid HitPay sandbox configuration.',
      },
      500
    );
  }

  // 2. Read raw request body & verify Hitpay-Signature BEFORE any DB write, update, or dedup lookup
  const rawBody = await req.text();
  if (!rawBody || rawBody.trim().length === 0) {
    return jsonResponse({ success: false, error: 'Empty webhook body.' }, 400);
  }

  const signatureHeader =
    req.headers.get('hitpay-signature') || req.headers.get('Hitpay-Signature') || '';
  const headerEventType =
    req.headers.get('hitpay-event-type') || req.headers.get('Hitpay-Event-Type') || '';
  const headerEventObject =
    req.headers.get('hitpay-event-object') || req.headers.get('Hitpay-Event-Object') || '';

  const verification = await verifyHitPayWebhookSignatureAsync(
    rawBody,
    signatureHeader,
    config.webhookSalt
  );

  if (!verification.isValid) {
    return jsonResponse(
      {
        success: false,
        code: 'invalid_signature',
        error: verification.error || 'Invalid or forged HitPay webhook signature.',
      },
      401
    );
  }

  let parsedPayload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse({ success: false, error: 'Webhook JSON payload must be an object.' }, 400);
    }
    parsedPayload = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON webhook payload.' }, 400);
  }

  const payloadHash = await sha256Hex(rawBody);
  const normalized = normalizeHitPayWebhook(parsedPayload, {
    eventType: headerEventType,
    eventObject: headerEventObject,
  });

  const providerEventId = normalized.providerEventId || `hp_gen_${crypto.randomUUID()}`;
  const eventType = normalized.eventType || 'unknown';

  // 3. Ingest HMAC-verified event into append-only provider_webhook_events inbox
  const { data: inboxRecord, error: inboxError } = await deps.supabaseAdmin
    .from('provider_webhook_events')
    .insert({
      provider_name: 'hitpay',
      provider_event_id: providerEventId,
      event_type: eventType,
      signature_verification_status: 'verified',
      signature_header: signatureHeader,
      payload_hash: payloadHash,
      processing_state: 'pending',
      last_error: null,
      payload: parsedPayload,
    })
    .select('id')
    .single();

  let activeInboxId: string = inboxRecord?.id;

  if (inboxError) {
    if (inboxError.code === '23505') {
      const { data: existingEvent, error: fetchErr } = await deps.supabaseAdmin
        .from('provider_webhook_events')
        .select('id, payload_hash, processing_state, updated_at, created_at')
        .eq('provider_name', 'hitpay')
        .eq('provider_event_id', providerEventId)
        .single();

      if (fetchErr || !existingEvent) {
        return jsonResponse({ error: 'Failed to inspect duplicate HitPay webhook event.' }, 500);
      }

      if (existingEvent.payload_hash !== payloadHash) {
        await deps.supabaseAdmin
          .from('provider_webhook_events')
          .update({ last_error: 'Conflicting payload hash for duplicate provider_event_id' })
          .eq('id', existingEvent.id);

        return jsonResponse(
          {
            success: false,
            error: 'Conflicting payload hash for duplicate provider_event_id',
          },
          409
        );
      }

      if (existingEvent.processing_state === 'processed') {
        return jsonResponse(
          {
            success: true,
            status: 'already_processed',
            message: 'Duplicate HitPay webhook event already processed.',
          },
          200
        );
      }

      if (existingEvent.processing_state === 'ignored_duplicate') {
        return jsonResponse(
          {
            success: true,
            status: 'already_processed',
            idempotent_replayed: true,
            message: 'Duplicate HitPay webhook event already acknowledged.',
          },
          200
        );
      }

      if (existingEvent.processing_state === 'processing') {
        const leaseTimestamp = new Date(
          existingEvent.updated_at || existingEvent.created_at
        ).getTime();
        const leaseAgeMs = Date.now() - leaseTimestamp;
        if (leaseAgeMs < 60_000) {
          return jsonResponse(
            {
              success: false,
              status: 'currently_processing',
              retryable: true,
              message: 'Webhook event is currently being processed under an active lease.',
            },
            409
          );
        }

        const { data: reclaimed, error: reclaimErr } = await deps.supabaseAdmin
          .from('provider_webhook_events')
          .update({
            processing_state: 'processing',
            last_error: 'Recovered stale processing lease',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingEvent.id)
          .eq('processing_state', 'processing')
          .eq('updated_at', existingEvent.updated_at)
          .select('id')
          .single();

        if (reclaimErr || !reclaimed) {
          return jsonResponse(
            {
              success: false,
              status: 'currently_processing',
              retryable: true,
              message: 'Concurrent stale lease recovery detected.',
            },
            409
          );
        }

        activeInboxId = reclaimed.id;
      } else {
        const { data: leased, error: leaseErr } = await deps.supabaseAdmin
          .from('provider_webhook_events')
          .update({ processing_state: 'processing', last_error: null })
          .eq('id', existingEvent.id)
          .eq('processing_state', existingEvent.processing_state)
          .select('id')
          .single();

        if (leaseErr || !leased) {
          return jsonResponse(
            {
              success: false,
              status: 'currently_processing',
              retryable: true,
              message: 'Concurrent webhook retry detected.',
            },
            409
          );
        }

        activeInboxId = leased.id;
      }
    } else {
      console.error('[hitpay-webhook] Inbox insert failed:', inboxError.message);
      return jsonResponse({ error: 'Unable to record webhook event.' }, 500);
    }
  }

  // Helper to record terminal failure / quarantine state on inbox row
  const failInbox = async (reason: string, httpStatus: number, code?: string) => {
    if (activeInboxId) {
      await deps.supabaseAdmin
        .from('provider_webhook_events')
        .update({
          processing_state: 'failed',
          last_error: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', activeInboxId);
    }
    return jsonResponse(
      code ? { success: false, code, error: reason } : { success: false, error: reason },
      httpStatus
    );
  };

  // 4. Enforce sandbox-only payload isolation (reject live mode payloads in Stage 2)
  const sandboxCheck = assertHitPaySandboxPayload(parsedPayload);
  if (!sandboxCheck.valid) {
    return failInbox(sandboxCheck.error || 'Non-sandbox webhook event rejected.', 400);
  }

  // 5. Process verified Capture Event
  if (normalized.status === 'paid') {
    const checkoutSessionId = (normalized.checkoutSessionId || '').trim();
    const providerPaymentId = (normalized.providerPaymentId || '').trim();
    const capturedAmount = normalized.capturedAmount;

    let currency: 'PHP';
    try {
      currency = assertHitPayPhpCurrency(normalized.currency || '');
    } catch (currErr: unknown) {
      return failInbox(
        currErr instanceof Error ? currErr.message : 'Unsupported currency.',
        400
      );
    }

    if (!checkoutSessionId || !providerPaymentId || !capturedAmount || capturedAmount <= 0) {
      return failInbox(
        'HitPay capture webhook payload missing mandatory payment request identity, payment identity, or positive amount.',
        400
      );
    }

    if (eventType !== 'payment_request.completed' && eventType !== 'charge.created') {
      return failInbox(`Unsupported HitPay capture event type "${eventType}".`, 400);
    }

    // MANDATORY AUTHORITATIVE RE-VERIFICATION via HitPay Sandbox API:
    // Verify GET https://api.sandbox.hit-pay.com/v1/payment-requests/{id}
    // confirms completed state, currency, decimal amount, and booking reference.
    const recheck = await getHitPayPaymentRequestStatus(checkoutSessionId, config, fetchFn);
    if (!recheck.ok || !recheck.data) {
      return failInbox(
        recheck.error || 'Unable to verify payment request status with HitPay sandbox API.',
        502
      );
    }

    const remote = recheck.data;
    const remoteStatus = String(remote.status || '').trim().toLowerCase();
    const remoteCurrency = String(remote.currency || '').trim().toUpperCase();
    const remoteAmount = parseHitPayDecimalAmount(remote.amount);
    const remoteRef = String(remote.reference_number || '').trim();

    if (String(remote.id || '').trim() !== checkoutSessionId) {
      return failInbox('Authoritative HitPay API returned mismatched payment request ID.', 400);
    }

    if (remote.url && !isHitPaySandboxCheckoutUrl(String(remote.url))) {
      return failInbox('Environment mismatch: HitPay API returned non-sandbox checkout URL.', 400);
    }

    if (remoteStatus !== 'completed') {
      return failInbox(
        `Authoritative HitPay status is "${remoteStatus || 'missing'}", expected "completed".`,
        400
      );
    }

    if (remoteCurrency !== 'PHP') {
      return failInbox(`Authoritative HitPay currency "${remoteCurrency}" is not PHP.`, 400);
    }

    if (remoteAmount === null || Math.abs(remoteAmount - capturedAmount) >= 0.001) {
      return failInbox(
        `Amount mismatch between webhook (${capturedAmount}) and HitPay API (${remoteAmount ?? 'null'}).`,
        400
      );
    }

    if (!remoteRef) {
      return failInbox('Authoritative HitPay payment request is missing reference_number.', 400);
    }

    if (normalized.referenceNumber && normalized.referenceNumber !== remoteRef) {
      return failInbox(
        `Reference number mismatch between webhook ("${normalized.referenceNumber}") and HitPay API ("${remoteRef}").`,
        400
      );
    }

    // Verify provider reference matches stored reservation reference_code BEFORE settlement
    const { data: storedPayment, error: payLookupErr } = await deps.supabaseAdmin
      .from('payments')
      .select('id, reservation_id, provider_name, checkout_session_id')
      .eq('provider_name', 'hitpay')
      .eq('checkout_session_id', checkoutSessionId)
      .maybeSingle();

    if (payLookupErr || !storedPayment) {
      return failInbox('Associated HitPay payment record not found for capture webhook.', 400);
    }

    const { data: storedReservation, error: resLookupErr } = await deps.supabaseAdmin
      .from('reservations')
      .select('id, reference_code')
      .eq('id', storedPayment.reservation_id)
      .maybeSingle();

    if (resLookupErr || !storedReservation) {
      return failInbox('Associated reservation record not found for HitPay capture webhook.', 400);
    }

    if (String(storedReservation.reference_code || '').trim() !== remoteRef) {
      return failInbox(
        `Booking reference mismatch: HitPay reference_number ("${remoteRef}") does not match stored booking reference_code ("${storedReservation.reference_code}").`,
        400,
        'reference_mismatch'
      );
    }

    const idempotencyKey = `wh_proc_hp_${providerEventId}_${providerPaymentId}`;
    const { data: processResult, error: processError } = await deps.supabaseAdmin.rpc(
      'process_verified_payment_event',
      {
        p_webhook_event_id: activeInboxId,
        p_provider_name: 'hitpay',
        p_provider_event_id: providerEventId,
        p_provider_payment_id: providerPaymentId,
        p_checkout_session_id: checkoutSessionId,
        p_captured_amount: capturedAmount,
        p_currency: currency,
        p_idempotency_key: idempotencyKey,
        p_metadata: {
          raw_event_type: eventType,
          gateway_reverified: true,
          hitpay_request_status: remoteStatus,
          reference_number: remoteRef,
        },
      }
    );

    if (processError) {
      console.error('[hitpay-webhook] process_verified_payment_event error:', processError.message);
      await deps.supabaseAdmin
        .from('provider_webhook_events')
        .update({
          processing_state: 'failed',
          last_error: processError.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', activeInboxId);

      const isClientMismatch =
        processError.message?.includes('not found') ||
        processError.message?.includes('mismatch') ||
        processError.message?.includes('Unsupported');

      return jsonResponse(
        { success: false, error: 'Unable to reconcile HitPay payment capture event.' },
        isClientMismatch ? 400 : 500
      );
    }

    return jsonResponse(processResult || { success: true }, 200);
  }

  // 6. Handle verified Refund Webhook Events (safe repeated partial & final refunds)
  if (normalized.status === 'refunded') {
    const providerRefundId = (normalized.refundId || '').trim();
    const lookupPaymentId = String(
      parsedPayload.payment_id ||
        parsedPayload.charge_id ||
        parsedPayload.provider_payment_id ||
        (headerEventObject.toLowerCase() === 'charge' ? parsedPayload.id : '') ||
        normalized.providerPaymentId ||
        ''
    ).trim();

    if (!providerRefundId) {
      return failInbox(
        'Ambiguous HitPay refund webhook: missing distinct refund_id. Ambiguous refund payloads are quarantined without posting ledger entries.',
        422,
        'ambiguous_refund_event'
      );
    }

    if (lookupPaymentId && providerRefundId === lookupPaymentId) {
      return failInbox(
        'Ambiguous HitPay refund webhook: refund_id cannot equal original charge/payment_id.',
        422,
        'ambiguous_refund_event'
      );
    }

    const valRefundedAmount = parseHitPayDecimalAmount(parsedPayload.refunded_amount);
    const valAmountRefunded = parseHitPayDecimalAmount(parsedPayload.amount_refunded);
    if (
      valRefundedAmount !== null &&
      valAmountRefunded !== null &&
      Math.abs(valRefundedAmount - valAmountRefunded) >= 0.001
    ) {
      return failInbox(
        `Ambiguous HitPay refund payload: refunded_amount (${valRefundedAmount}) disagrees with amount_refunded (${valAmountRefunded}).`,
        422,
        'ambiguous_refund_event'
      );
    }

    // Resolve internal payment record safely
    let paymentRecord: {
      id: string;
      provider_payment_id?: string | null;
      checkout_session_id?: string | null;
      status?: string | null;
      captured_amount?: number | string | null;
      refunded_amount?: number | string | null;
      currency?: string | null;
      verified_capture_evidence?: Record<string, unknown> | null;
    } | null = null;

    if (lookupPaymentId) {
      const { data: byPay } = await deps.supabaseAdmin
        .from('payments')
        .select(
          'id, provider_payment_id, checkout_session_id, status, captured_amount, refunded_amount, currency, verified_capture_evidence'
        )
        .eq('provider_name', 'hitpay')
        .eq('provider_payment_id', lookupPaymentId)
        .maybeSingle();
      if (byPay) paymentRecord = byPay;
    }
    if (!paymentRecord && normalized.checkoutSessionId) {
      const { data: bySess } = await deps.supabaseAdmin
        .from('payments')
        .select(
          'id, provider_payment_id, checkout_session_id, status, captured_amount, refunded_amount, currency, verified_capture_evidence'
        )
        .eq('provider_name', 'hitpay')
        .eq('checkout_session_id', normalized.checkoutSessionId)
        .maybeSingle();
      if (bySess) paymentRecord = bySess;
    }

    if (!paymentRecord) {
      return failInbox('Associated HitPay payment record not found for refund webhook.', 404);
    }

    if (
      paymentRecord.provider_payment_id &&
      providerRefundId === paymentRecord.provider_payment_id
    ) {
      return failInbox(
        'Ambiguous HitPay refund webhook: refund_id matches stored charge ID.',
        422,
        'ambiguous_refund_event'
      );
    }

    // If this specific refund_id was already recorded on the payment, replay idempotently without double-posting
    const existingEvidence =
      paymentRecord.verified_capture_evidence &&
      typeof paymentRecord.verified_capture_evidence === 'object'
        ? paymentRecord.verified_capture_evidence
        : {};
    const existingRefundEntry = existingEvidence[`refund_${providerRefundId}`] as
      | Record<string, unknown>
      | undefined;

    if (existingRefundEntry) {
      if (activeInboxId) {
        await deps.supabaseAdmin
          .from('provider_webhook_events')
          .update({
            processing_state: 'ignored_duplicate',
            processed_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('id', activeInboxId);
      }

      return jsonResponse(
        {
          success: true,
          status: 'already_refunded',
          idempotent_replayed: true,
          payment_id: paymentRecord.id,
          provider_refund_id: providerRefundId,
          total_refunded: Number(paymentRecord.refunded_amount || 0),
        },
        200
      );
    }

    // Authoritative refund verification via GET /v1/refund/{refund_id}
    const refundRecheck = await getHitPayRefundStatus(providerRefundId, config, fetchFn);
    if (!refundRecheck.ok || !refundRecheck.data) {
      return failInbox(
        refundRecheck.error || 'Unable to verify refund record via HitPay sandbox API.',
        502
      );
    }

    const remoteRefund = refundRecheck.data;
    if (String(remoteRefund.id || '').trim() !== providerRefundId) {
      return failInbox(
        'Ambiguous HitPay refund verification: remote refund ID mismatch.',
        422,
        'ambiguous_refund_event'
      );
    }

    const remoteRefundStatus = String(remoteRefund.status || '').trim().toLowerCase();
    if (!['succeeded', 'completed', 'refunded'].includes(remoteRefundStatus)) {
      return failInbox(
        `Authoritative HitPay refund status is "${remoteRefundStatus || 'missing'}", expected succeeded/refunded.`,
        422,
        'ambiguous_refund_event'
      );
    }

    const remoteRefundCurrency = String(remoteRefund.currency || 'PHP').trim().toUpperCase();
    if (remoteRefundCurrency !== 'PHP') {
      return failInbox(
        `Authoritative HitPay refund currency "${remoteRefundCurrency}" is not PHP.`,
        422,
        'ambiguous_refund_event'
      );
    }

    const remoteChargeId = String(remoteRefund.payment_id || remoteRefund.charge_id || '').trim();
    if (
      remoteChargeId &&
      paymentRecord.provider_payment_id &&
      remoteChargeId !== paymentRecord.provider_payment_id
    ) {
      return failInbox(
        `Ambiguous HitPay refund linkage: refund belongs to payment "${remoteChargeId}", expected "${paymentRecord.provider_payment_id}".`,
        422,
        'ambiguous_refund_event'
      );
    }

    const verifiedIncrementalAmount = parseHitPayDecimalAmount(
      remoteRefund.amount_refunded ?? remoteRefund.refunded_amount ?? remoteRefund.amount
    );
    if (!verifiedIncrementalAmount || verifiedIncrementalAmount <= 0) {
      return failInbox(
        'Authoritative HitPay refund API missing positive refund amount.',
        422,
        'ambiguous_refund_event'
      );
    }

    // Reconcile webhook payload amounts unambiguously against GET /v1/refund/{id}
    const priorRefunded = Number(paymentRecord.refunded_amount || 0);
    const expectedCumulative = Math.round((priorRefunded + verifiedIncrementalAmount) * 100) / 100;
    const explicitIncremental = parseHitPayDecimalAmount(parsedPayload.refund_amount);
    const chargeRefundField = valAmountRefunded ?? valRefundedAmount;
    const payloadAmountField = parseHitPayDecimalAmount(parsedPayload.amount);

    if (
      explicitIncremental !== null &&
      Math.abs(explicitIncremental - verifiedIncrementalAmount) >= 0.001
    ) {
      return failInbox(
        `Ambiguous HitPay refund payload: refund_amount (${explicitIncremental}) disagrees with HitPay API (${verifiedIncrementalAmount}).`,
        422,
        'ambiguous_refund_event'
      );
    }

    if (chargeRefundField !== null) {
      const matchesIncremental = Math.abs(chargeRefundField - verifiedIncrementalAmount) < 0.001;
      const matchesCumulative =
        explicitIncremental === null && Math.abs(chargeRefundField - expectedCumulative) < 0.001;

      if (!matchesIncremental && !matchesCumulative) {
        return failInbox(
          `Ambiguous HitPay refund payload: webhook refund field (${chargeRefundField}) matches neither incremental (${verifiedIncrementalAmount}) nor cumulative (${expectedCumulative}).`,
          422,
          'ambiguous_refund_event'
        );
      }
    } else if (explicitIncremental === null) {
      if (
        payloadAmountField === null ||
        Math.abs(payloadAmountField - verifiedIncrementalAmount) >= 0.001
      ) {
        return failInbox(
          `Ambiguous HitPay refund payload: webhook amount (${payloadAmountField ?? 'null'}) does not match verified refund amount (${verifiedIncrementalAmount}).`,
          422,
          'ambiguous_refund_event'
        );
      }
    }

    const capturedTotal = Number(paymentRecord.captured_amount || 0);
    if (capturedTotal > 0 && expectedCumulative > capturedTotal + 0.001) {
      return failInbox(
        `Ambiguous HitPay refund amount: cumulative refund (${expectedCumulative}) exceeds captured amount (${capturedTotal}).`,
        422,
        'ambiguous_refund_event'
      );
    }

    const { data: refundRes, error: refundErr } = await deps.supabaseAdmin.rpc(
      'process_verified_refund_event',
      {
        p_payment_id: paymentRecord.id,
        p_refund_amount: verifiedIncrementalAmount,
        p_reason: String(parsedPayload.reason || 'HitPay verified refund webhook'),
        p_provider_refund_id: providerRefundId,
        p_refund_evidence: {
          webhook_event_id: activeInboxId,
          provider_event_id: providerEventId,
          provider_name: 'hitpay',
          gateway_refund_verified: true,
          verified_refund_amount: verifiedIncrementalAmount,
        },
        p_idempotency_key: `wh_refund_hp_${providerRefundId}_${paymentRecord.id}`,
        p_is_partial: String(parsedPayload.status || '').toLowerCase() === 'partially_refunded',
        p_metadata: { raw_event_type: eventType },
      }
    );

    if (refundErr) {
      console.error('[hitpay-webhook] process_verified_refund_event error:', refundErr.message);
      return failInbox('Unable to process HitPay refund webhook event.', 500);
    }

    return jsonResponse(refundRes || { success: true, status: 'refund_processed' }, 200);
  }

  // 7. Non-capture failed/canceled/expired or informational events: acknowledge safely
  if (activeInboxId) {
    await deps.supabaseAdmin
      .from('provider_webhook_events')
      .update({
        processing_state: 'processed',
        processed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', activeInboxId);
  }

  return jsonResponse({ success: true, status: 'acknowledged', event_type: eventType }, 200);
}
