// ==============================================================================
// CourtBook / BookSuite — Create Checkout Session Edge Function
// Endpoint: POST /create-checkout-session
//
// Description:
//   Accepts client checkout requests, validates inputs, invokes the secure database
//   procedure public.create_booking_checkout_session to lock the court slot,
//   create the pending reservation hold, compute the server-authoritative price
//   and 5% commission snapshot, and return payment session parameters.
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

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

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server environment misconfiguration.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Call the database function create_booking_checkout_session
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
      p_checkout_session_id: null,
      p_provider_name: body.provider_name || 'paymongo',
    });

    if (error) {
      const isConflict = error.message.includes('already reserved') || error.message.includes('exclusion_violation');
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        {
          status: isConflict ? 409 : 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
