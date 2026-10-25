// ==============================================================================
// CourtBook / BookSuite — Secure Public Booking Edge Function
// Endpoint: POST /create-booking
//
// Description:
//   Accepts public customer booking requests securely with enterprise defense-in-depth:
//   1. Request Body Protection: Enforces 16KB size limit and strict JSON parsing.
//   2. Anti-Bot / CAPTCHA Verification: Server-side validation via Cloudflare Turnstile
//      siteverify API. Security fails closed (HTTP 503) if Turnstile secret is unconfigured
//      in production. ALLOW_INSECURE_TESTING is strictly locked to local development environments
//      (localhost / 127.0.0.1) and is ignored on any deployed public endpoint.
//   3. Rate-Limit Security & Untrusted Client IP Isolation:
//      Per security policy, does NOT rely on CF-Connecting-IP, X-Real-IP, or forwarded headers
//      for security decisions unless their authenticity is guaranteed by documented hosting infrastructure.
//      Instead, enforces two mandatory database-backed rate limiters on EVERY public booking request:
//        A. Facility Burst Rate Limit (25 attempts / 60s per facility) to prevent rapid slot starvation.
//        B. Customer Contact Rate Limit (5 attempts / 60s per customer contact).
//   4. Keyed HMAC Privacy for Rate Limiting:
//      Customer contact identifiers (email/phone) are normalized and hashed using a server-side
//      keyed HMAC-SHA256 before being queried or stored as database rate-limit keys.
//      The HMAC secret is kept strictly inside the Edge Function environment and is never exposed.
//   5. Mandatory Database Idempotency: Requires a valid idempotency key (16-128 chars) on EVERY
//      request. Calls create_public_reservation_idempotent() to atomically register the key,
//      fingerprint request parameters, serialize concurrency, and create the reservation.
//   6. Strict Input Sanitization: Validates facility UUID, court UUID, ISO timestamps,
//      booking date, duration (30-480m), customer name, and contact details.
//   7. Anti-Tampering (Zero-Trust): Never trusts client-supplied pricing, status,
//      confirmation mode, or is_demo flag. All business rules and rates are enforced
//      by the locked database procedures.
//   8. Privacy & PII Protection: Server logs never record customer contact details
//      (emails, phone numbers, or customer names) or secrets.
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, idempotency-key, x-turnstile-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface BookingRequestBody {
  facility_id: string;
  court_id: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  booking_date: string; // YYYY-MM-DD
  start_time: string; // ISO 8601 UTC timestamp
  duration_minutes?: number;
  idempotency_key?: string;
  captcha_token?: string;
  cf_turnstile_response?: string;
  // Note: is_demo in the request payload is strictly ignored to prevent client privilege tampering
  is_demo?: unknown;
}

const MAX_PAYLOAD_BYTES = 16384; // 16 KB max request size
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const IDEMPOTENCY_REGEX = /^[A-Za-z0-9_\-:.]{16,128}$/;

/**
 * Computes a keyed HMAC-SHA256 hex digest for sensitive identifiers (e.g. customer contact).
 * Protects customer PII from being stored in plaintext in the database rate-limits table.
 * The secret is maintained strictly within the Edge Function server environment.
 */
async function computeHmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalizes customer contact identifiers before HMAC hashing.
 * - Emails are trimmed and lowercased.
 * - Phone numbers are trimmed of spaces, hyphens, parentheses, and dots.
 * If both are provided, canonicalizes with email as primary.
 */
function normalizeContactIdentifier(email?: string | null, phone?: string | null): string {
  const normEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normPhone = typeof phone === 'string' ? phone.trim().replace(/[\s().-]/g, '') : '';

  if (normEmail) {
    return `email:${normEmail}`;
  }
  return `phone:${normPhone}`;
}

/**
 * Verifies Cloudflare Turnstile CAPTCHA token with Cloudflare siteverify endpoint.
 * Note: Remote IP is intentionally omitted from siteverify to avoid relying on
 * unauthenticated client-supplied IP headers (CF-Connecting-IP, X-Real-IP).
 */
async function verifyCloudflareTurnstile(
  secretKey: string,
  token: string
): Promise<{ success: boolean; errorCodes?: string[] }> {
  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      return { success: false, errorCodes: [`http_${response.status}`] };
    }

    const result = await response.json();
    return {
      success: Boolean(result.success),
      errorCodes: result['error-codes'] || [],
    };
  } catch {
    return { success: false, errorCodes: ['network_error'] };
  }
}

serve(async (req: Request) => {
  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // 2. Reject Disallowed HTTP Methods
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed. Use POST.' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // 3. Request Size Protection (Prevent DoS and Memory Flooding)
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Payload too large. Maximum request body is ${MAX_PAYLOAD_BYTES} bytes.`,
        }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Read Server-Side Privileged Credentials (NEVER exposed to frontend)
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Server misconfiguration: Database service credentials are not configured.',
          code: 'SERVER_MISCONFIGURED',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Dedicated Server-Side HMAC Secret (Strict Requirement — NO fallback to service-role key)
    const rawHmacSecret = Deno.env.get('CONTACT_HMAC_SECRET');
    const contactHmacSecret = typeof rawHmacSecret === 'string' ? rawHmacSecret.trim() : '';

    if (!contactHmacSecret || contactHmacSecret.length < 16) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Server misconfiguration: Customer contact security secret (CONTACT_HMAC_SECRET) is missing or invalid.',
          code: 'SERVER_MISCONFIGURED',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 5. Parse and Validate JSON Payload
    let body: BookingRequestBody;
    try {
      const rawText = await req.text();
      if (rawText.length > MAX_PAYLOAD_BYTES) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Payload too large. Maximum request body is ${MAX_PAYLOAD_BYTES} bytes.`,
          }),
          { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      body = JSON.parse(rawText);
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Malformed JSON payload.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 6. Mandatory Idempotency Key Validation
    // Every genuine booking request MUST supply a valid 16-128 character idempotency key.
    const rawIdempotencyKey =
      req.headers.get('idempotency-key') || body.idempotency_key || '';
    const idempotencyKey = typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : '';

    if (!idempotencyKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Missing required idempotency key. Provide a valid idempotency_key parameter or Idempotency-Key header.',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!IDEMPOTENCY_REGEX.test(idempotencyKey)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid idempotency_key format. Must be 16-128 alphanumeric characters, dashes, dots, underscores, or colons.',
          code: 'INVALID_IDEMPOTENCY_KEY',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 7. Cloudflare Turnstile Bot Protection (SECURITY FAILS CLOSED)
    // Configuration Safety: ALLOW_INSECURE_TESTING is strictly locked to local development
    // (localhost / 127.0.0.1) and is completely ignored on any deployed public endpoint.
    const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY');
    const isLocalEnvironment =
      supabaseUrl.includes('localhost') ||
      supabaseUrl.includes('127.0.0.1') ||
      supabaseUrl.includes('kong:8000') ||
      supabaseUrl.includes('.internal');

    const allowInsecureTesting =
      Deno.env.get('ALLOW_INSECURE_TESTING') === 'true' && isLocalEnvironment;

    const submittedCaptchaToken =
      body.captcha_token ||
      body.cf_turnstile_response ||
      req.headers.get('x-turnstile-token') ||
      '';

    if (!turnstileSecret || turnstileSecret.trim().length === 0) {
      // Deployed public endpoints MUST fail closed if bot protection is unconfigured
      if (!allowInsecureTesting) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Server misconfiguration: Bot protection service is not configured.',
            code: 'BOT_PROTECTION_UNAVAILABLE',
          }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      // Only local development allows insecure testing bypass
    } else {
      // In production (or when Turnstile is configured), require a valid token
      if (!submittedCaptchaToken.trim()) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Bot verification required. Missing CAPTCHA verification token.',
            code: 'CAPTCHA_REQUIRED',
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const turnstileCheck = await verifyCloudflareTurnstile(
        turnstileSecret.trim(),
        submittedCaptchaToken.trim()
      );

      if (!turnstileCheck.success) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Bot verification failed or challenge expired. Please complete the CAPTCHA.',
            code: 'CAPTCHA_REJECTED',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // 8. Initialize Privileged Supabase Admin Client (service_role)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    // 9. Extract & Validate Parameters
    const {
      facility_id,
      court_id,
      customer_name,
      customer_phone,
      customer_email,
      booking_date,
      start_time,
      duration_minutes = 60,
    } = body;

    // Validate Facility ID & Court ID
    if (!facility_id || !UUID_REGEX.test(facility_id)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid or missing facility_id parameter.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!court_id || !UUID_REGEX.test(court_id)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid or missing court_id parameter.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate Customer Name (never logged in server logs)
    const trimmedName = typeof customer_name === 'string' ? customer_name.trim() : '';
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Customer name must be between 2 and 100 characters.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Reject control characters or script injection attempts in customer name
    if (/[\x00-\x1F\x7F<>]/.test(trimmedName)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Customer name contains invalid characters.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate Contact Info: At least one required
    const trimmedPhone = typeof customer_phone === 'string' ? customer_phone.trim() : '';
    const trimmedEmail = typeof customer_email === 'string' ? customer_email.trim() : '';

    if (!trimmedPhone && !trimmedEmail) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'At least one contact method (phone or email) is required.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (trimmedPhone && (trimmedPhone.length > 30 || !/^[0-9+\s().-]{7,30}$/.test(trimmedPhone))) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid customer phone number format.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (trimmedEmail && (!EMAIL_REGEX.test(trimmedEmail) || trimmedEmail.length > 255)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid customer email address format.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate Date Format
    if (!booking_date || !DATE_REGEX.test(booking_date)) {
      return new Response(
        JSON.stringify({ success: false, error: 'booking_date must be in YYYY-MM-DD format.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate Start Time
    if (!start_time || isNaN(Date.parse(start_time))) {
      return new Response(
        JSON.stringify({ success: false, error: 'start_time must be a valid ISO 8601 timestamp string.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const parsedStartTime = new Date(start_time);
    if (parsedStartTime.getTime() <= Date.now()) {
      return new Response(
        JSON.stringify({ success: false, error: 'Cannot book reservations in the past.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate Duration (30 - 480 mins in 30-minute steps)
    const duration = Number(duration_minutes);
    if (isNaN(duration) || duration < 30 || duration > 480 || duration % 30 !== 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'duration_minutes must be between 30 and 480 minutes in 30-minute increments.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 10. Durable Database-Backed Rate Limiting (FAILS CLOSED)
    // Security Architecture:
    // 1. Untrusted Client IP Headers: CF-Connecting-IP, X-Real-IP, and X-Forwarded-For are
    //    untrusted client-supplied headers in serverless edge environments unless guaranteed
    //    by documented infrastructure. Reliance on them for security decisions has been removed.
    // 2. Multi-Layered Protection on EVERY public booking request:
    //    A. Facility Burst Protection: Enforces 25 requests/minute across the entire facility.
    //       Prevents rapid-fire slot starvation and coordinated abuse against any venue.
    //    B. Customer Contact Rate Limit: Enforces 5 requests/minute per customer.
    // 3. Keyed HMAC Privacy: Customer contact identifiers are normalized and hashed with
    //    a server-side keyed HMAC-SHA256 (with secret stored strictly in the Edge Function
    //    environment) before use as database keys, completely preventing PII leakage in the rate limit store.
    // 4. Fail-Closed: If any rate-limiting RPC call fails, times out, or errors, the request
    //    is rejected immediately with HTTP 503.

    // A. Facility Burst Rate Limit (enforced on EVERY public booking request)
    const facilityBurstKey = `facility:${facility_id}:burst`;
    const { data: burstLimit, error: burstErr } = await supabaseAdmin.rpc(
      'check_and_increment_rate_limit',
      {
        p_rate_key: facilityBurstKey,
        p_max_attempts: 25,
        p_window_seconds: 60,
      }
    );

    if (burstErr || !burstLimit || typeof burstLimit.allowed !== 'boolean') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Security rate-limiting verification unavailable. Please try again shortly.',
          code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (burstLimit.allowed === false) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Facility booking traffic is unusually high. Please wait ${burstLimit.retry_after_seconds} seconds before trying again.`,
          code: 'RATE_LIMIT_EXCEEDED',
          retry_after: burstLimit.retry_after_seconds,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(burstLimit.retry_after_seconds || 60),
          },
        }
      );
    }

    // B. Customer Contact Rate Limit (enforced on EVERY public booking request with keyed HMAC)
    const normalizedContact = normalizeContactIdentifier(trimmedEmail, trimmedPhone);
    const contactHmac = await computeHmacSha256(contactHmacSecret, normalizedContact);
    const contactRateKey = `contact:${contactHmac}`;

    const { data: contactLimit, error: contactLimitErr } = await supabaseAdmin.rpc(
      'check_and_increment_rate_limit',
      {
        p_rate_key: contactRateKey,
        p_max_attempts: 5,
        p_window_seconds: 60,
      }
    );

    if (contactLimitErr || !contactLimit || typeof contactLimit.allowed !== 'boolean') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Security rate-limiting verification unavailable. Please try again shortly.',
          code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (contactLimit.allowed === false) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Too many booking requests for this contact. Please wait ${contactLimit.retry_after_seconds} seconds before trying again.`,
          code: 'RATE_LIMIT_EXCEEDED',
          retry_after: contactLimit.retry_after_seconds,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(contactLimit.retry_after_seconds || 60),
          },
        }
      );
    }

    // 11. Call Privileged Atomic Idempotent Database Function
    // Idempotency registration, request fingerprint validation, concurrency serialization,
    // and reservation creation are executed ATOMICALLY in a single database transaction.
    const { data, error } = await supabaseAdmin.rpc('create_public_reservation_idempotent', {
      p_idempotency_key: idempotencyKey,
      p_facility_id: facility_id,
      p_court_id: court_id,
      p_customer_name: trimmedName,
      p_customer_phone: trimmedPhone || null,
      p_customer_email: trimmedEmail || null,
      p_booking_date: booking_date,
      p_start_time: parsedStartTime.toISOString(),
      p_duration_minutes: duration,
      p_is_demo: false, // Strict server enforcement: Never trust client is_demo flag
    });

    if (error) {
      // Distinguish error categories
      const isIdempotencyMismatch = error.message.includes('Idempotency key mismatch');
      const isConcurrentInProgress = error.message.includes('concurrent booking request');

      const isConflict =
        error.code === '23P01' ||
        error.message.includes('already booked') ||
        error.message.includes('exclusion violation') ||
        error.message.includes('held for another pending request');

      const isHoursOrBlock =
        error.message.includes('operating hours') ||
        error.message.includes('maintenance') ||
        error.message.includes('outside the facility operating schedule');

      const isNotFound = error.message.includes('not found') || error.code === 'P0002';

      let status = 400;
      let errorCode = 'BOOKING_CREATION_FAILED';

      if (isIdempotencyMismatch) {
        status = 400;
        errorCode = 'IDEMPOTENCY_KEY_MISMATCH';
      } else if (isConcurrentInProgress) {
        status = 409;
        errorCode = 'CONCURRENT_REQUEST_IN_PROGRESS';
      } else if (isConflict) {
        status = 409;
        errorCode = 'SLOT_UNAVAILABLE';
      } else if (isHoursOrBlock) {
        status = 400;
        errorCode = 'HOURS_OR_BLOCK_CONFLICT';
      } else if (isNotFound) {
        status = 404;
        errorCode = 'RESOURCE_NOT_FOUND';
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: error.message,
          code: errorCode,
        }),
        { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!data || !data.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: data?.error || 'Failed to create reservation.',
          code: data?.error_code || 'CREATION_FAILED',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 12. Authoritative Database Response Mapping & Field Validation
    // The PostgreSQL function create_public_reservation_idempotent() returns v_res directly:
    // a flat JSONB object with top-level fields:
    //   success, reservation_id, reference_code, status, total_price, currency,
    //   hold_expires_at, booking_confirmation_mode, court_name, facility_name,
    //   booking_date, time_slot_label, is_demo, idempotent_replayed
    //
    // Handle both flat database RPC return shape and any nested data.reservation envelope.
    const source =
      data.reservation && typeof data.reservation === 'object'
        ? data.reservation
        : data;

    // 1. Authoritative Reservation ID
    const rawId = source.reservation_id ?? source.id ?? data.reservation_id ?? data.id;
    const reservationId = typeof rawId === 'string' ? rawId.trim() : '';

    // 2. Authoritative Reference Code
    const rawRef =
      source.reference_code ??
      source.booking_reference ??
      data.reference_code ??
      data.booking_reference;
    const referenceCode = typeof rawRef === 'string' ? rawRef.trim() : '';

    // 3. Authoritative Status ('confirmed' | 'pending')
    const rawStatus = typeof (source.status ?? data.status) === 'string'
      ? String(source.status ?? data.status).toLowerCase().trim()
      : '';

    // 4. Authoritative Total Price
    const rawPrice = source.total_price ?? source.price ?? data.total_price ?? data.price;
    let totalPrice: number | null = null;
    if (typeof rawPrice === 'number' && !isNaN(rawPrice)) {
      totalPrice = rawPrice;
    } else if (typeof rawPrice === 'string' && rawPrice.trim().length > 0) {
      const cleaned = rawPrice.replace(/[^0-9.-]/g, '').trim();
      const parsed = Number(cleaned);
      if (!isNaN(parsed) && cleaned.length > 0) {
        totalPrice = parsed;
      }
    }

    const isValidId = UUID_REGEX.test(reservationId);
    const isValidRef = referenceCode.length > 0;
    const isValidStatus = rawStatus === 'confirmed' || rawStatus === 'pending';
    const isValidPrice = totalPrice !== null && totalPrice >= 0;

    // Validation Barrier: Fail closed if database returned an incomplete or invalid record
    if (!isValidId || !isValidRef || !isValidStatus || !isValidPrice) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'The booking service returned an incomplete or invalid reservation record.',
          code: 'INCOMPLETE_DATABASE_RESPONSE',
          details: {
            has_valid_id: isValidId,
            has_valid_ref: isValidRef,
            has_valid_status: isValidStatus,
            has_valid_price: isValidPrice,
          },
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authoritativeStatus: 'confirmed' | 'pending' = rawStatus as 'confirmed' | 'pending';
    const isIdempotentReplay = Boolean(data.idempotent_replayed || source.idempotent_replayed);
    const httpStatus = isIdempotentReplay ? 200 : 201;

    // Hold Expiration: Preserved strictly for pending reservations; never invented for confirmed bookings
    const rawHold =
      source.hold_expires_at ??
      source.expires_at ??
      data.hold_expires_at ??
      data.expires_at;
    const holdExpiresAt =
      authoritativeStatus === 'pending' && typeof rawHold === 'string' && rawHold.trim().length > 0
        ? rawHold.trim()
        : null;

    const confirmationMode = String(
      source.booking_confirmation_mode ??
      source.confirmation_mode ??
      data.booking_confirmation_mode ??
      data.confirmation_mode ??
      (authoritativeStatus === 'pending' ? 'manual_approval' : 'instant')
    ).trim();

    const courtName = String(source.court_name ?? data.court_name ?? '').trim();
    const facilityName = String(source.facility_name ?? data.facility_name ?? '').trim();
    const resolvedBookingDate = String(
      source.booking_date ?? data.booking_date ?? booking_date ?? ''
    ).trim();
    const timeSlotLabel = String(source.time_slot_label ?? data.time_slot_label ?? '').trim();
    const currency = String(source.currency ?? data.currency ?? 'PHP').trim();

    // Explicit authoritative reservation object matching client expectations
    const reservationObj = {
      id: reservationId,
      reservation_id: reservationId,
      reference_code: referenceCode,
      booking_reference: referenceCode,
      status: authoritativeStatus,
      price: totalPrice,
      total_price: totalPrice,
      currency,
      booking_date: resolvedBookingDate,
      time_slot_label: timeSlotLabel,
      court_name: courtName,
      facility_name: facilityName,
      hold_expires_at: holdExpiresAt,
      expires_at: holdExpiresAt,
      booking_confirmation_mode: confirmationMode,
      confirmation_mode: confirmationMode,
      idempotent_replayed: isIdempotentReplay,
      is_demo: false,
    };

    // Return authoritative success envelope matching supabaseClient.ts and BookingPage.tsx
    return new Response(
      JSON.stringify({
        success: true,
        reservation: reservationObj,
        data: reservationObj,
        reservation_id: reservationId,
        id: reservationId,
        reference_code: referenceCode,
        booking_reference: referenceCode,
        status: authoritativeStatus,
        price: totalPrice,
        total_price: totalPrice,
        currency,
        hold_expires_at: holdExpiresAt,
        expires_at: holdExpiresAt,
        booking_confirmation_mode: confirmationMode,
        confirmation_mode: confirmationMode,
        court_name: courtName,
        facility_name: facilityName,
        booking_date: resolvedBookingDate,
        time_slot_label: timeSlotLabel,
        idempotent_replayed: isIdempotentReplay,
        payment_required: false,
        is_demo: false,
      }),
      { status: httpStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    // Top-level unhandled exception handler
    // Never leak internal stack traces or secrets in production response
    return new Response(
      JSON.stringify({
        success: false,
        error: 'An internal server error occurred processing the reservation.',
        code: 'INTERNAL_SERVER_ERROR',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
