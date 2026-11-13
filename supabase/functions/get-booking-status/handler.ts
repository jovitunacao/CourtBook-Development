// ==============================================================================
// CourtBook / BookSuite — Authoritative Public Booking Status Verification Handler
//
// Security & Financial Compliance:
//   - Requires authoritative financial capture evidence (005B / 005C):
//     * Reservation / payment / facility / organization / court relationship integrity
//     * Valid provider_payment_id and bound checkout_session_id (not cs_pending_*)
//     * Valid non-null captured_at timestamp
//     * Exact captured_amount == expected_amount == reservation.price
//     * Non-empty verified_capture_evidence with webhook_event_id & provider_event_id
//     * Verified & processed provider_webhook_events record
//     * Settlement journal entry in financial_transactions (booking_settlement)
//   - Durable server-side rate limiting via check_and_increment_rate_limit (004)
//     across both client IP (anti-enumeration) and reference key
//   - Cryptographic guest lookup_token verification, UUIDv4 reservation_id, or
//     normalized customer phone/email verification
//   - Safe public error handling (never leaks SQL, stack traces, or internal IDs)
// ==============================================================================

import { verifyGuestLookupToken } from '../_shared/guestLookupToken.ts';

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export interface GetBookingStatusRequest {
  reservation_id?: string;
  reference_code: string;
  payment_id?: string;
  contact?: string;
  lookup_token?: string;
}

export interface SupabaseQueryResult<T = any> {
  data: T | null;
  error: { message?: string; code?: string } | null;
}

export interface SupabaseAdminLike {
  from: (table: string) => any;
  rpc: (fn: string, params?: Record<string, unknown>) => Promise<SupabaseQueryResult<any>>;
}

export interface GetBookingStatusDeps {
  supabaseAdmin: SupabaseAdminLike;
  lookupSecret: string;
  rateLimitMap?: Map<string, { count: number; resetAt: number }>;
  nowMs?: () => number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_CODE_REGEX = /^CB-[A-Z0-9-]{6,30}$/i;
const VALID_CAPTURE_EVENT_TYPES = new Set([
  'payment.paid',
  'checkout_session.payment.paid',
  'payment.captured',
]);

const defaultMemoryRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function jsonResponse(body: Record<string, unknown>, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
  });
}

function checkMemoryRateLimit(
  map: Map<string, { count: number; resetAt: number }>,
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number
): { allowed: boolean; retryAfter: number } {
  const entry = map.get(key);
  if (!entry || nowMs > entry.resetAt) {
    map.set(key, { count: 1, resetAt: nowMs + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.resetAt - nowMs) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}

async function evaluateDurableRateLimit(
  deps: GetBookingStatusDeps,
  rateKey: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<{ allowed: boolean; retryAfter: number }> {
  const memMap = deps.rateLimitMap || defaultMemoryRateLimitMap;
  const now = deps.nowMs ? deps.nowMs() : Date.now();

  try {
    const { data: rlData, error: rlErr } = await deps.supabaseAdmin.rpc('check_and_increment_rate_limit', {
      p_rate_key: rateKey,
      p_max_attempts: maxAttempts,
      p_window_seconds: windowSeconds,
    });

    if (!rlErr && rlData && typeof rlData.allowed === 'boolean') {
      return {
        allowed: rlData.allowed,
        retryAfter: Number(rlData.retry_after_seconds) || windowSeconds,
      };
    }

    if (rlErr) {
      console.error('[get-booking-status] Durable rate limit RPC error:', rlErr.message || 'unknown');
    }
  } catch (err) {
    console.error('[get-booking-status] Durable rate limit RPC exception:', err);
  }

  return checkMemoryRateLimit(memMap, rateKey, maxAttempts, windowSeconds * 1000, now);
}

function normalizePhPhoneDigits(raw: string): string {
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('63') && digits.length === 12) {
    return digits.slice(2); // 9XXXXXXXXX
  }
  if (digits.startsWith('09') && digits.length === 11) {
    return digits.slice(1); // 9XXXXXXXXX
  }
  return digits;
}

export function doesContactMatch(
  suppliedContact: string,
  storedPhone: string | null | undefined,
  storedEmail: string | null | undefined
): boolean {
  const trimmed = (suppliedContact || '').trim();
  if (!trimmed) return false;

  // Email check (case-insensitive exact match)
  const storedEmailNorm = (storedEmail || '').trim().toLowerCase();
  const suppliedEmailNorm = trimmed.toLowerCase();
  if (storedEmailNorm.length >= 5 && suppliedEmailNorm.includes('@') && suppliedEmailNorm === storedEmailNorm) {
    return true;
  }

  // Phone check (normalized PH digits or exact >= 7 digits)
  const storedDigits = normalizePhPhoneDigits(storedPhone || '');
  const suppliedDigits = normalizePhPhoneDigits(trimmed);
  if (storedDigits.length >= 7 && suppliedDigits.length >= 7 && storedDigits === suppliedDigits) {
    return true;
  }

  return false;
}

export async function handleGetBookingStatusRequest(
  req: Request,
  deps: GetBookingStatusDeps
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    let body: GetBookingStatusRequest;
    try {
      body = (await req.json()) as GetBookingStatusRequest;
    } catch {
      return jsonResponse({ error: 'Invalid request payload.' }, 400);
    }

    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Invalid request payload.' }, 400);
    }

    const referenceCode = (body.reference_code || '').trim().toUpperCase();
    const reservationId = (body.reservation_id || '').trim();
    const paymentId = (body.payment_id || '').trim();
    const contact = (body.contact || '').trim();
    const lookupToken = (body.lookup_token || '').trim();

    // 1. Strict validation of reference_code and credential presence
    if (!referenceCode || !REF_CODE_REGEX.test(referenceCode)) {
      return jsonResponse(
        { error: 'A valid booking reference code is required (e.g. CB-XXXXXXXX).' },
        400
      );
    }

    if (!reservationId && !contact && !lookupToken) {
      return jsonResponse(
        {
          error:
            'Guest verification is required. Please provide a valid booking token, reservation ID, or booking contact.',
        },
        400
      );
    }

    if (reservationId && !UUID_REGEX.test(reservationId)) {
      return jsonResponse({ error: 'Invalid reservation identifier format.' }, 400);
    }

    if (paymentId && !UUID_REGEX.test(paymentId)) {
      return jsonResponse({ error: 'Invalid payment identifier format.' }, 400);
    }

    // 2. Durable multi-bucket rate limiting (IP + Reference)
    const rawIp =
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-real-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      'unknown';
    const cleanIp = rawIp.trim().replace(/[^a-z0-9.:_-]/gi, '_') || 'unknown';

    const ipRate = await evaluateDurableRateLimit(deps, `status_ip_${cleanIp}`, 30, 60);
    if (!ipRate.allowed) {
      return jsonResponse(
        { error: 'Too many status requests. Please wait a moment before trying again.' },
        429,
        { 'Retry-After': String(ipRate.retryAfter) }
      );
    }

    const refRate = await evaluateDurableRateLimit(
      deps,
      `status_ref_${referenceCode}_${cleanIp}`,
      12,
      60
    );
    if (!refRate.allowed) {
      return jsonResponse(
        { error: 'Rate limit exceeded for this reference code. Please wait a moment before trying again.' },
        429,
        { 'Retry-After': String(refRate.retryAfter) }
      );
    }

    // 3. Cryptographic guest lookup token verification (when supplied)
    let tokenReservationId: string | undefined;
    if (lookupToken) {
      if (!deps.lookupSecret) {
        console.error('[get-booking-status] Missing lookupSecret for token verification.');
        return jsonResponse({ error: 'Booking status service is temporarily unavailable.' }, 500);
      }

      const tokenCheck = await verifyGuestLookupToken(lookupToken, referenceCode, deps.lookupSecret);
      if (!tokenCheck.valid || !tokenCheck.reservationId || !UUID_REGEX.test(tokenCheck.reservationId)) {
        return jsonResponse(
          { error: 'Booking lookup token is invalid or expired. Please verify using your booking contact.' },
          403
        );
      }

      if (reservationId && reservationId !== tokenCheck.reservationId) {
        return jsonResponse({ error: 'Guest verification failed.' }, 403);
      }

      tokenReservationId = tokenCheck.reservationId;
    }

    const effectiveReservationId = reservationId || tokenReservationId;

    // 4. Query reservation (columns verified against 001 + 003)
    let resQuery = deps.supabaseAdmin
      .from('reservations')
      .select(
        `
        id,
        facility_id,
        court_id,
        reference_code,
        customer_name,
        customer_phone,
        customer_email,
        booking_date,
        start_time,
        end_time,
        time_slot_label,
        duration_minutes,
        price,
        currency,
        status,
        is_demo,
        hold_expires_at,
        created_at,
        updated_at
      `
      )
      .eq('reference_code', referenceCode);

    if (effectiveReservationId) {
      resQuery = resQuery.eq('id', effectiveReservationId);
    }

    const { data: reservation, error: resError } = await resQuery.maybeSingle();

    if (resError) {
      console.error('[get-booking-status] Reservations query error:', resError);
      return jsonResponse({ error: 'Unable to retrieve booking status at this time.' }, 500);
    }

    if (!reservation) {
      return jsonResponse(
        { error: 'Reservation record not found. Please verify your booking reference code.' },
        404
      );
    }

    // 5. Guest contact verification (mandatory if no token/UUID, and always verified if supplied)
    if (contact || (!tokenReservationId && !reservationId)) {
      if (!doesContactMatch(contact, reservation.customer_phone, reservation.customer_email)) {
        return jsonResponse(
          { error: 'Customer contact details do not match the reservation on file.' },
          403
        );
      }
    }

    // 6. Query Facility & Court separately (avoids PostgREST implicit join issues & verifies tenant linkage)
    const { data: facility, error: facError } = await deps.supabaseAdmin
      .from('facilities')
      .select('id, organization_id, name, timezone, currency, address')
      .eq('id', reservation.facility_id)
      .maybeSingle();

    if (facError || !facility) {
      console.error('[get-booking-status] Facility lookup failure:', facError);
      return jsonResponse({ error: 'Unable to verify booking facility details.' }, 500);
    }

    const { data: court, error: courtError } = await deps.supabaseAdmin
      .from('courts')
      .select('id, name, sport_type, facility_id')
      .eq('id', reservation.court_id)
      .maybeSingle();

    if (courtError || !court) {
      console.error('[get-booking-status] Court lookup failure:', courtError);
      return jsonResponse({ error: 'Unable to verify booking court details.' }, 500);
    }

    if (court.facility_id !== reservation.facility_id) {
      console.error('[get-booking-status] Cross-facility court mismatch:', {
        reservationId: reservation.id,
        reservationFacilityId: reservation.facility_id,
        courtFacilityId: court.facility_id,
      });
      return jsonResponse({ error: 'Booking integrity verification failed.' }, 403);
    }

    // 7. Query bound payment record (columns verified against 005B)
    let paymentQuery = deps.supabaseAdmin
      .from('payments')
      .select(
        `
        id,
        organization_id,
        facility_id,
        reservation_id,
        status,
        currency,
        expected_amount,
        captured_amount,
        provider_name,
        provider_payment_id,
        checkout_session_id,
        verified_capture_evidence,
        captured_at,
        expires_at,
        created_at,
        updated_at
      `
      )
      .eq('reservation_id', reservation.id);

    if (paymentId) {
      paymentQuery = paymentQuery.eq('id', paymentId);
    }

    const { data: payments, error: payError } = await paymentQuery.order('created_at', { ascending: false });

    if (payError) {
      console.error('[get-booking-status] Payment lookup failure:', payError);
      return jsonResponse({ error: 'Unable to retrieve payment status at this time.' }, 500);
    }

    const payment = payments && payments.length > 0 ? payments[0] : null;

    // 8. Composite Tenant & Relationship Integrity Validation (005B)
    if (payment) {
      if (
        payment.reservation_id !== reservation.id ||
        payment.facility_id !== reservation.facility_id ||
        payment.organization_id !== facility.organization_id
      ) {
        console.error('[get-booking-status] Cross-tenant payment relationship mismatch:', {
          paymentId: payment.id,
          paymentOrg: payment.organization_id,
          facilityOrg: facility.organization_id,
          paymentFacility: payment.facility_id,
          reservationFacility: reservation.facility_id,
          paymentReservation: payment.reservation_id,
          reservationId: reservation.id,
        });
        return jsonResponse({ error: 'Booking verification failed due to an integrity mismatch.' }, 403);
      }
    }

    // 9. Financial Capture Evidence Validation (005B + 005C)
    const rawResStatus = String(reservation.status || 'pending').toLowerCase().trim();
    const rawPayStatus = String(payment?.status || 'pending').toLowerCase().trim();

    const reservationPrice = Number(reservation.price);
    const expectedAmount = payment ? Number(payment.expected_amount) : reservationPrice;
    const capturedAmount = payment ? Number(payment.captured_amount) : 0;

    const evidence = payment?.verified_capture_evidence;
    const isPlainEvidenceObj =
      Boolean(evidence) && typeof evidence === 'object' && !Array.isArray(evidence);

    const evidenceWebhookId = isPlainEvidenceObj ? String(evidence.webhook_event_id || '').trim() : '';
    const evidenceProviderEventId = isPlainEvidenceObj
      ? String(evidence.provider_event_id || '').trim()
      : '';
    const evidenceCapturedAt = isPlainEvidenceObj ? String(evidence.captured_at || '').trim() : '';

    const isAmountExact =
      Number.isFinite(capturedAmount) &&
      Number.isFinite(expectedAmount) &&
      Number.isFinite(reservationPrice) &&
      capturedAmount > 0 &&
      Math.abs(capturedAmount - expectedAmount) < 0.001 &&
      Math.abs(capturedAmount - reservationPrice) < 0.001;

    const hasValidProviderBinding =
      Boolean(payment?.provider_payment_id && String(payment.provider_payment_id).trim().length > 0) &&
      Boolean(
        payment?.checkout_session_id &&
          String(payment.checkout_session_id).trim().length > 0 &&
          !String(payment.checkout_session_id).startsWith('cs_pending_')
      );

    const hasValidCaptureTimestamp =
      Boolean(payment?.captured_at) && !Number.isNaN(Date.parse(String(payment.captured_at)));

    const hasCaptureEvidenceFields =
      isPlainEvidenceObj &&
      evidence.amount_mismatch !== true &&
      evidence.late_payment !== true &&
      UUID_REGEX.test(evidenceWebhookId) &&
      evidenceProviderEventId.length > 0 &&
      evidenceCapturedAt.length > 0 &&
      !Number.isNaN(Date.parse(evidenceCapturedAt));

    // Verify referenced webhook event row in provider_webhook_events (005B + 005C)
    let hasVerifiedWebhookRecord = false;
    if (payment && rawPayStatus === 'captured' && hasCaptureEvidenceFields) {
      const { data: webhookRow, error: whError } = await deps.supabaseAdmin
        .from('provider_webhook_events')
        .select('id, provider_name, provider_event_id, event_type, signature_verification_status, processing_state')
        .eq('id', evidenceWebhookId)
        .maybeSingle();

      if (whError) {
        console.error('[get-booking-status] Webhook evidence query error:', whError);
      } else if (
        webhookRow &&
        webhookRow.signature_verification_status === 'verified' &&
        webhookRow.processing_state === 'processed' &&
        webhookRow.provider_event_id === evidenceProviderEventId &&
        webhookRow.provider_name === payment.provider_name &&
        VALID_CAPTURE_EVENT_TYPES.has(String(webhookRow.event_type || ''))
      ) {
        hasVerifiedWebhookRecord = true;
      }
    }

    const hasValidEvidence =
      hasValidProviderBinding &&
      hasValidCaptureTimestamp &&
      hasCaptureEvidenceFields &&
      hasVerifiedWebhookRecord;

    // 10. Settlement Journal Association Check (005A1 + 005C financial_transactions)
    let hasSettlementJournal = false;
    if (payment && rawPayStatus === 'captured') {
      const { data: txData, error: txError } = await deps.supabaseAdmin
        .from('financial_transactions')
        .select('id, transaction_number, organization_id, facility_id, transaction_type, reference_id')
        .eq('reference_id', reservation.id)
        .eq('transaction_type', 'booking_settlement')
        .eq('organization_id', facility.organization_id)
        .eq('facility_id', reservation.facility_id)
        .maybeSingle();

      if (txError) {
        console.error('[get-booking-status] Settlement journal query error:', txError);
      } else if (
        txData &&
        txData.reference_id === reservation.id &&
        txData.organization_id === facility.organization_id &&
        txData.facility_id === reservation.facility_id &&
        txData.transaction_type === 'booking_settlement'
      ) {
        hasSettlementJournal = true;
      }
    }

    // 11. Deterministic Authoritative Status Calculation
    const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
    const isHoldExpired =
      Boolean(reservation.hold_expires_at) &&
      new Date(reservation.hold_expires_at).getTime() <= nowMs &&
      rawResStatus !== 'confirmed';

    const hasAmountMismatch =
      (isPlainEvidenceObj && evidence.amount_mismatch === true) ||
      (rawPayStatus === 'captured' && !isAmountExact);

    const isLatePayment = isPlainEvidenceObj && evidence.late_payment === true;

    let calculatedStatus: 'pending' | 'processing' | 'confirmed' | 'failed' | 'cancelled' | 'expired' =
      'pending';
    let verified = false;

    if (hasAmountMismatch || rawPayStatus === 'failed') {
      calculatedStatus = 'failed';
    } else if (
      rawResStatus === 'cancelled' ||
      rawResStatus === 'declined' ||
      rawPayStatus === 'cancelled' ||
      rawPayStatus === 'refunded' ||
      rawPayStatus === 'partially_refunded' ||
      rawPayStatus === 'disputed'
    ) {
      calculatedStatus = 'cancelled';
    } else if (rawResStatus === 'expired' || isHoldExpired || isLatePayment) {
      calculatedStatus = 'expired';
    } else if (
      rawResStatus === 'confirmed' &&
      rawPayStatus === 'captured' &&
      isAmountExact &&
      hasValidEvidence &&
      hasSettlementJournal
    ) {
      calculatedStatus = 'confirmed';
      verified = true;
    } else if (
      rawPayStatus === 'processing' ||
      rawPayStatus === 'requires_action' ||
      (rawResStatus === 'confirmed' && rawPayStatus === 'captured' && (!hasSettlementJournal || !hasValidEvidence))
    ) {
      // Never report confirmed/verified when capture evidence or settlement journal is missing
      calculatedStatus = 'processing';
      verified = false;
    } else {
      calculatedStatus = 'pending';
    }

    // 12. Scrubbed Authoritative Public Response (no raw phone/email, no internal secrets)
    const responsePayload = {
      success: true,
      verified,
      status: calculatedStatus,
      reservation_status: rawResStatus,
      payment_status: rawPayStatus,
      reservation_id: reservation.id,
      reference_code: reservation.reference_code,
      payment_id: payment?.id || null,
      total_price: reservationPrice,
      currency: reservation.currency || '₱',
      duration_minutes: Number(reservation.duration_minutes) || 60,
      customer_name: reservation.customer_name,
      hold_expires_at: reservation.hold_expires_at,
      facility_name: facility.name,
      facility_address: facility.address || '',
      court_name: court.name,
      sport_type: court.sport_type || 'Court Sport',
      booking_date: reservation.booking_date,
      time_slot_label: reservation.time_slot_label,
      confirmed_at: verified ? String(payment.captured_at) : null,
      settlement_verified: hasSettlementJournal,
      has_capture_evidence: hasValidEvidence,
    };

    return jsonResponse(responsePayload, 200);
  } catch (err: unknown) {
    // Log diagnostics strictly on server; never return internal error details publicly
    console.error('[get-booking-status] Unhandled exception:', err);
    return jsonResponse(
      { error: 'An unexpected error occurred while verifying booking status. Please try again shortly.' },
      500
    );
  }
}
