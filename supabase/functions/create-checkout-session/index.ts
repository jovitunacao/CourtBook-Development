// ==============================================================================
// CourtBook / BookSuite — Create Checkout Session Edge Function
// Endpoint: POST /create-checkout-session
//
// Description:
//   Accepts customer checkout requests, validates inputs and anti-abuse bounds,
//   invokes the secure database procedure public.create_booking_checkout_session
//   to lock the court slot and calculate server-authoritative rates and 5% commission,
//   interacts with the trusted payment provider adapter to create a real checkout session,
//   and securely binds the returned provider checkout ID to the payment record.
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import { mintGuestLookupToken } from '../_shared/guestLookupToken.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CreateCheckoutBody {
  facility_id: string;
  court_id: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  booking_date: string;
  start_time: string;
  duration_minutes?: number;
  idempotency_key?: string;
  provider_name?: string;
}

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
    const body: CreateCheckoutBody = await req.json();

    const idempotencyKey = req.headers.get('idempotency-key') || body.idempotency_key;
    if (!idempotencyKey || idempotencyKey.length < 16) {
      return new Response(
        JSON.stringify({ error: 'A valid idempotency-key (min 16 chars) is required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const providerName = (body.provider_name || 'paymongo').toLowerCase().trim();
    if (providerName === 'xendit') {
      return new Response(
        JSON.stringify({
          error: 'Xendit payment provider adapter is marked NOT READY. Official production integration pending.',
          is_ready: false,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server environment misconfiguration.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Call database procedure to initialize hold and compute server-authoritative rates
    const { data, error } = await supabaseAdmin.rpc('create_booking_checkout_session', {
      p_idempotency_key: idempotencyKey,
      p_facility_id: body.facility_id,
      p_court_id: body.court_id,
      p_customer_name: body.customer_name,
      p_customer_phone: body.customer_phone || null,
      p_customer_email: body.customer_email || null,
      p_booking_date: body.booking_date,
      p_start_time: body.start_time,
      p_duration_minutes: body.duration_minutes || 60,
      p_provider_name: providerName,
    });

    if (error) {
      console.error('[create-checkout-session] create_booking_checkout_session RPC error:', error.message);
      const isConflict =
        error.message.includes('already reserved') || error.message.includes('exclusion_violation');
      return new Response(
        JSON.stringify({
          success: false,
          error: isConflict
            ? 'Selected court time slot is already reserved. Please select another slot.'
            : 'Unable to initialize checkout for the selected booking details. Please verify your information and try again.',
        }),
        {
          status: isConflict ? 409 : 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const lookupSecret = Deno.env.get('BOOKING_LOOKUP_TOKEN_SECRET') || supabaseServiceKey;
    const lookupToken = await mintGuestLookupToken({
      reservationId: String(data.reservation_id),
      referenceCode: String(data.reference_code),
      secret: lookupSecret,
      ttlSeconds: 7200,
    });

    // 2. If already bound and replayed idempotently, return existing session details
    if (data.idempotent_replayed && data.checkout_url && !data.checkout_session_id.startsWith('cs_pending_')) {
      return new Response(JSON.stringify({ ...data, lookup_token: lookupToken }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Create Checkout Session via trusted Provider Adapter
    const paymongoSecretKey = Deno.env.get('PAYMONGO_SECRET_KEY') || '';
    const appEnv = Deno.env.get('ENVIRONMENT') || Deno.env.get('NODE_ENV') || 'development';
    const allowSimulation = Deno.env.get('ALLOW_PAYMENT_SIMULATION') === 'true';
    const appBaseUrl = Deno.env.get('APP_BASE_URL') || 'https://courtbook.app';
    const amountCentavos = Math.round(Number(data.expected_amount) * 100);

    let providerCheckoutId: string;
    let checkoutUrl: string;
    let isSimulated = false;

    if (paymongoSecretKey.startsWith('sk_live_') || paymongoSecretKey.startsWith('sk_test_')) {
      const authHeader = 'Basic ' + btoa(`${paymongoSecretKey}:`);

      // On idempotent replay where local binding previously failed, check PayMongo for an existing active session
      // matching this reference_code before creating a second payable checkout session.
      let recoveredExisting = false;
      if (data.idempotent_replayed) {
        try {
          const listRes = await fetch('https://api.paymongo.com/v1/checkout_sessions?limit=10', {
            method: 'GET',
            headers: { 'Authorization': authHeader },
          });
          if (listRes.ok) {
            const listJson = await listRes.json();
            const sessions = Array.isArray(listJson?.data) ? listJson.data : [];
            const matched = sessions.find(
              (s: any) =>
                s?.attributes?.reference_number === data.reference_code &&
                s?.attributes?.status === 'active' &&
                s?.attributes?.checkout_url
            );
            if (matched) {
              providerCheckoutId = matched.id;
              checkoutUrl = matched.attributes.checkout_url;
              recoveredExisting = true;
            }
          }
        } catch {
          // Proceed to creation if lookup fails
        }
      }

      if (!recoveredExisting && data.idempotent_replayed) {
        return new Response(
          JSON.stringify({
            success: false,
            status: 'reconciliation_required',
            payment_id: data.payment_id,
            reference_code: data.reference_code,
            error: 'Checkout session recovery failed or no active provider session found. Booking marked for reconciliation; refusing to create a duplicate payable session.',
          }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!recoveredExisting) {
        // Official PayMongo API invocation using server-authoritative pricing
        const pmRes = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify({
          data: {
            attributes: {
              send_email_receipt: true,
              show_description: true,
              show_line_items: true,
              description: `CourtBook: ${data.court_name} (${data.time_slot_label})`,
              line_items: [
                {
                  currency: data.currency,
                  amount: amountCentavos,
                  name: `Court Rental: ${data.court_name}`,
                  quantity: 1,
                },
              ],
              payment_method_types: ['card', 'gcash', 'paymaya', 'grab_pay'],
              reference_number: data.reference_code,
              success_url: `${appBaseUrl}/booking/success?ref=${data.reference_code}&token=${encodeURIComponent(lookupToken)}`,
              cancel_url: `${appBaseUrl}/booking/cancelled?ref=${data.reference_code}&token=${encodeURIComponent(lookupToken)}`,
              metadata: {
                reservation_id: data.reservation_id,
                payment_id: data.payment_id,
                reference_code: data.reference_code,
              },
            },
          },
        }),
      });

      if (!pmRes.ok) {
        const pmErr = await pmRes.text();
        console.error('[create-checkout-session] PayMongo API error:', pmRes.status, pmErr);
        return new Response(
          JSON.stringify({
            error: 'Payment provider is temporarily unable to create a checkout session. Please try again shortly.',
          }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

        const pmJson = await pmRes.json();
        providerCheckoutId = pmJson.data.id;
        checkoutUrl = pmJson.data.attributes.checkout_url;
      }
    } else {
      // In production or when simulation is not explicitly configured, fail closed
      if (appEnv === 'production' || !allowSimulation) {
        return new Response(
          JSON.stringify({
            error: 'Missing production PayMongo credentials. Simulation is prohibited in production and requires explicit configuration.',
            is_ready: false
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Explicit development-only simulated sandbox mode
      isSimulated = true;
      providerCheckoutId = `cs_sandbox_${data.reference_code}`;
      checkoutUrl = `${appBaseUrl}/sandbox/checkout?cs=${providerCheckoutId}&ref=${data.reference_code}`;
    }

    // 4. Securely bind the returned provider checkout ID to the reservation and payment record
    // Includes secure retry / lookup recovery to prevent duplicate provider sessions if transient failure occurs
    let bindSuccess = false;
    let bindErrorMsg = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data: bindData, error: bindError } = await supabaseAdmin.rpc('bind_provider_checkout_session', {
        p_payment_id: data.payment_id,
        p_reservation_id: data.reservation_id,
        p_provider_name: providerName,
        p_checkout_session_id: providerCheckoutId,
        p_checkout_url: checkoutUrl,
        p_idempotency_key: `${idempotencyKey}_bind`,
        p_metadata: {
          is_simulated: isSimulated,
          provider_session_id: providerCheckoutId,
          attempt,
        },
      });

      if (!bindError && bindData?.success) {
        bindSuccess = true;
        break;
      }

      bindErrorMsg = bindError?.message || 'Binding failed';
      // If error indicates it is already bound to this session, treat as recovered success
      if (bindErrorMsg.includes('already bound') || bindData?.status === 'already_bound') {
        bindSuccess = true;
        break;
      }
    }

    if (!bindSuccess) {
      console.error('[create-checkout-session] Checkout session binding failure:', {
        referenceCode: data.reference_code,
        bindErrorMsg,
      });
      return new Response(
        JSON.stringify({
          error: 'Unable to finalize checkout session binding. Please retry to recover your booking hold.',
          reference_code: data.reference_code,
          recovery_instruction: 'Retry request with same idempotency key to recover bound session without creating duplicate sessions.',
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        ...data,
        checkout_session_id: providerCheckoutId,
        checkout_url: checkoutUrl,
        lookup_token: lookupToken,
        is_simulated: isSimulated,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: unknown) {
    console.error('[create-checkout-session] Unhandled exception:', err);
    return new Response(
      JSON.stringify({ error: 'Unable to initialize checkout session. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
