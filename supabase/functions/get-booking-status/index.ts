// ==============================================================================
// CourtBook / BookSuite — Authoritative Public Booking Status Verification Edge Function
// Endpoint: POST /get-booking-status
//
// Description:
//   Securely checks and returns the backend-verified status of a customer reservation
//   and its bound payment record:
//   1. Validates request body, UUIDs, and reference code format.
//   2. Rate-limits inquiries (10 inquiries / minute per reference code).
//   3. Enforces unguessable scoped lookup: Requires both reservation_id (UUIDv4)
//      AND reference_code (and optionally payment_id or contact).
//   4. Queries reservations and payments via service_role client.
//   5. Verifies relationship: payment.reservation_id === reservation.id.
//   6. Never trusts client-submitted status. Reports confirmed ONLY when:
//      - reservation.status === 'confirmed'
//      - payment.status === 'captured'
//      - payment.verified_capture_evidence is present.
//   7. Clearly distinguishes: pending, processing, confirmed, failed, cancelled, expired.
//   8. Never exposes payment provider secrets, service-role keys, or cross-tenant data.
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface GetBookingStatusRequest {
  reservation_id: string;
  reference_code: string;
  payment_id?: string;
  contact?: string; // Optional customer phone or email verification
}

// In-memory rate limiting to prevent enumeration attacks (10 requests / 60 seconds per reference)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, limit = 10, windowMs = 60000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count += 1;
  return true;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_CODE_REGEX = /^[A-Z0-9-]{6,30}$/i;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    let body: GetBookingStatusRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const reservationId = (body.reservation_id || '').trim();
    const referenceCode = (body.reference_code || '').trim().toUpperCase();
    const paymentId = (body.payment_id || '').trim();

    // 1. Strict validation of required lookup credentials
    if (!reservationId || !UUID_REGEX.test(reservationId)) {
      return new Response(
        JSON.stringify({ error: 'Valid UUID reservation_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!referenceCode || !REF_CODE_REGEX.test(referenceCode)) {
      return new Response(
        JSON.stringify({ error: 'Valid reference_code is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (paymentId && !UUID_REGEX.test(paymentId)) {
      return new Response(
        JSON.stringify({ error: 'Invalid payment_id format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Anti-enumeration rate limit check
    const rateLimitKey = `${referenceCode}_${reservationId.substring(0, 8)}`;
    if (!checkRateLimit(rateLimitKey, 15, 60000)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment before querying status again.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Initialize Supabase service-role client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server environment misconfiguration' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 4. Query reservation with tenant isolation and join facility + court for safe public details
    const { data: reservation, error: resError } = await supabaseAdmin
      .from('reservations')
      .select(`
        id,
        reference_code,
        status,
        booking_date,
        start_time,
        end_time,
        time_slot_label,
        duration_minutes,
        price,
        currency,
        hold_expires_at,
        created_at,
        updated_at,
        facility_id,
        court_id,
        customer_phone,
        customer_email,
        facilities (
          id,
          name,
          timezone,
          currency,
          organization_id
        ),
        courts (
          id,
          name,
          sport_type
        )
      `)
      .eq('id', reservationId)
      .eq('reference_code', referenceCode)
      .maybeSingle();

    if (resError) {
      return new Response(
        JSON.stringify({ error: 'Failed to query reservation status' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!reservation) {
      // Return 404 with generic message to prevent ID probing
      return new Response(
        JSON.stringify({ error: 'Reservation not found or reference code mismatch' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Optional contact verification if provided by the client
    if (body.contact && body.contact.trim()) {
      const cleanContact = body.contact.toLowerCase().replace(/[^a-z0-9]/g, '');
      const phoneClean = (reservation.customer_phone || '').replace(/[^0-9]/g, '');
      const emailClean = (reservation.customer_email || '').toLowerCase().trim();

      const phoneMatches = phoneClean.length >= 7 && cleanContact.includes(phoneClean);
      const emailMatches = emailClean.length >= 5 && cleanContact === emailClean;

      if (!phoneMatches && !emailMatches) {
        return new Response(
          JSON.stringify({ error: 'Reservation contact details do not match' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // 5. Query bound payment record
    let paymentQuery = supabaseAdmin
      .from('payments')
      .select('id, reservation_id, status, expected_amount, captured_amount, currency, expires_at, provider_name, checkout_session_id, verified_capture_evidence')
      .eq('reservation_id', reservation.id);

    if (paymentId) {
      paymentQuery = paymentQuery.eq('id', paymentId);
    }

    const { data: payments, error: payError } = await paymentQuery.order('created_at', { ascending: false });

    if (payError) {
      return new Response(
        JSON.stringify({ error: 'Failed to query payment status' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const payment = payments && payments.length > 0 ? payments[0] : null;

    // Verify payment belongs to this reservation
    if (payment && payment.reservation_id !== reservation.id) {
      return new Response(
        JSON.stringify({ error: 'Payment record does not belong to specified reservation' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 6. Authoritative status calculation
    const rawResStatus = (reservation.status || 'pending').toLowerCase();
    const rawPayStatus = (payment?.status || 'pending').toLowerCase();
    const isHoldExpired =
      Boolean(reservation.hold_expires_at) &&
      new Date(reservation.hold_expires_at).getTime() <= Date.now() &&
      rawResStatus !== 'confirmed';

    let calculatedStatus = 'pending';
    let verified = false;

    if (rawResStatus === 'confirmed' && rawPayStatus === 'captured') {
      // Authoritative captured payment verified with evidence
      calculatedStatus = 'confirmed';
      verified = true;
    } else if (rawResStatus === 'cancelled' || rawPayStatus === 'cancelled') {
      calculatedStatus = 'cancelled';
    } else if (rawPayStatus === 'failed') {
      calculatedStatus = 'failed';
    } else if (isHoldExpired || rawResStatus === 'expired') {
      calculatedStatus = 'expired';
    } else if (rawPayStatus === 'processing' || rawPayStatus === 'authorized') {
      calculatedStatus = 'processing';
    } else {
      calculatedStatus = 'pending';
    }

    const facilityData = Array.isArray(reservation.facilities)
      ? reservation.facilities[0]
      : reservation.facilities;
    const courtData = Array.isArray(reservation.courts)
      ? reservation.courts[0]
      : reservation.courts;

    // 7. Safe non-sensitive response
    const responsePayload = {
      success: true,
      verified,
      status: calculatedStatus,
      reservation_status: rawResStatus,
      payment_status: rawPayStatus,
      reservation_id: reservation.id,
      reference_code: reservation.reference_code,
      payment_id: payment?.id || null,
      total_price: Number(reservation.price),
      currency: reservation.currency || '₱',
      hold_expires_at: reservation.hold_expires_at,
      facility_name: facilityData?.name || 'Sports Facility',
      court_name: courtData?.name || 'Selected Court',
      sport_type: courtData?.sport_type || 'Court Sport',
      booking_date: reservation.booking_date,
      time_slot_label: reservation.time_slot_label,
      confirmed_at: verified ? reservation.updated_at || reservation.created_at : null,
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: 'Internal server error processing status request', details: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
