// ==============================================================================
// CourtBook / BookSuite — Authoritative Public Booking Status Verification Edge Function
// Endpoint: POST /get-booking-status
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import {
  corsHeaders,
  handleGetBookingStatusRequest,
} from './handler.ts';

serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const lookupSecret = Deno.env.get('BOOKING_LOOKUP_TOKEN_SECRET') || supabaseServiceKey;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[get-booking-status] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    return new Response(
      JSON.stringify({ error: 'Booking status service is temporarily unavailable.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  return handleGetBookingStatusRequest(req, {
    supabaseAdmin,
    lookupSecret,
  });
});
