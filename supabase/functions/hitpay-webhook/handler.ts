// ==============================================================================
// LockaCourt (AratReserve) — HitPay Sandbox Webhook Handler
// File: supabase/functions/hitpay-webhook/handler.ts
//
// Security & Verification Pipeline:
//   1. Reads exact raw request body (rejects legacy form-urlencoded callbacks)
//   2. Verifies Hitpay-Signature HMAC-SHA256 hex digest using webhook salt
//   3. Enforces Stage 2 sandbox isolation (rejects live env/flags/URLs/payloads)
//   4. Stores raw event in append-only provider_webhook_events inbox with
//      duplicate payload_hash conflict detection and lease management
//   5. Authoritatively re-queries GET /v1/payment-requests/{id} on HitPay Sandbox
//      to confirm completed status, currency, decimal amount, and reference
//      BEFORE invoking process_verified_payment_event
// ==============================================================================

import {
  assertHitPayPhpCurrency,
  assertHitPaySandboxPayload,
  getHitPayPaymentRequestStatus,
  isHitPaySandboxCheckoutUrl,
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

  // Fail closed on sandbox configuration / live credentials / missing webhook salt or API key
  let config: ReturnType<typeof resolveHitPaySandboxConfig>;
  try {
    config = resolveHitPaySandboxConfig(env);
    if (!config.webhookSalt || !config.apiKey) {
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

  const rawBody = await req.text();
  if (!rawBody || rawBody.trim().length === 0) {
    return jsonResponse({ success: false, error: 'Empty webhook body.' }, 400);
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
  const signatureStatus = verification.isValid ? 'verified' : 'failed';
  const payloadHash = await sha256Hex(rawBody);

  const normalized = normalizeHitPayWebhook(parsedPayload, {
    eventType: headerEventType,
    eventObject: headerEventObject,
  });

  const providerEventId = normalized.providerEventId || `hp_gen_${crypto.randomUUID()}`;
  const eventType = normalized.eventType || 'unknown';

  // 1. Ingest into append-only provider_webhook_events
  const { data: inboxRecord, error: inboxError } = await deps.supabaseAdmin
    .from('provider_webhook_events')
    .insert({
      provider_name: 'hitpay',
      provider_event_id: providerEventId,
      event_type: eventType,
      signature_verification_status: signatureStatus,
      signature_header: signatureHeader,
      payload_hash: payloadHash,
      processing_state: verification.isValid ? 'pending' : 'failed',
      last_error: verification.isValid ? null : verification.error,
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

      if (!verification.isValid) {
        return jsonResponse(
          { success: false, error: 'Invalid or forged HitPay webhook signature.' },
          401
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

  // 2. Reject invalid HMAC signatures before any processing
  if (!verification.isValid) {
    return jsonResponse(
      { success: false, error: 'Invalid or forged HitPay webhook signature.' },
      401
    );
  }

  // Helper to record terminal failure state on inbox row
  const failInbox = async (reason: string, httpStatus: number) => {
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
    return jsonResponse({ success: false, error: reason }, httpStatus);
  };

  // 3. Enforce sandbox-only payload isolation (reject live mode payloads in Stage 2)
  const sandboxCheck = assertHitPaySandboxPayload(parsedPayload);
  if (!sandboxCheck.valid) {
    return failInbox(sandboxCheck.error || 'Non-sandbox webhook event rejected.', 400);
  }

  // 4. Process verified Capture Event
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

    if (
      eventType !== 'payment_request.completed' &&
      eventType !== 'charge.created'
    ) {
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

    if (normalized.referenceNumber && remoteRef && normalized.referenceNumber !== remoteRef) {
      return failInbox(
        `Reference number mismatch between webhook ("${normalized.referenceNumber}") and HitPay API ("${remoteRef}").`,
        400
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
          reference_number: remoteRef || normalized.referenceNumber || null,
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

  // 5. Handle verified Refund Webhook Events
  if (normalized.status === 'refunded') {
    const providerRefundId = String(
      parsedPayload.refund_id || parsedPayload.id || normalized.providerPaymentId || ''
    ).trim();
    const lookupPaymentId = String(
      parsedPayload.payment_id || normalized.providerPaymentId || ''
    ).trim();
    const refundAmount = parseHitPayDecimalAmount(
      parsedPayload.refunded_amount ?? parsedPayload.amount_refunded ?? parsedPayload.amount
    );

    if (!providerRefundId || !refundAmount || refundAmount <= 0) {
      return failInbox('HitPay refund webhook missing refund identifier or valid refund amount.', 400);
    }

    // Resolve internal payment record safely
    let paymentRecord: { id: string } | null = null;
    if (lookupPaymentId) {
      const { data: byPay } = await deps.supabaseAdmin
        .from('payments')
        .select('id')
        .eq('provider_name', 'hitpay')
        .eq('provider_payment_id', lookupPaymentId)
        .maybeSingle();
      if (byPay) paymentRecord = byPay;
    }
    if (!paymentRecord && normalized.checkoutSessionId) {
      const { data: bySess } = await deps.supabaseAdmin
        .from('payments')
        .select('id')
        .eq('provider_name', 'hitpay')
        .eq('checkout_session_id', normalized.checkoutSessionId)
        .maybeSingle();
      if (bySess) paymentRecord = bySess;
    }

    if (!paymentRecord) {
      return failInbox('Associated HitPay payment record not found for refund webhook.', 404);
    }

    const { data: refundRes, error: refundErr } = await deps.supabaseAdmin.rpc(
      'process_verified_refund_event',
      {
        p_payment_id: paymentRecord.id,
        p_refund_amount: refundAmount,
        p_reason: String(parsedPayload.reason || 'HitPay verified refund webhook'),
        p_provider_refund_id: providerRefundId,
        p_refund_evidence: {
          webhook_event_id: activeInboxId,
          provider_event_id: providerEventId,
          provider_name: 'hitpay',
        },
        p_idempotency_key: `wh_refund_hp_${providerEventId}_${providerRefundId}`,
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

  // 6. Non-capture failed/canceled/expired or informational events: acknowledge safely
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
