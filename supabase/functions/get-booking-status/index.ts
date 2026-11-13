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

serve(async (req: Request, connInfo: { remoteAddr?: { transport?: string; hostname?: string } }) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const lookupSecret = Deno.env.get('BOOKING_LOOKUP_TOKEN_SECRET') || supabaseServiceKey;
  const trustedProxyIpHeader = Deno.env.get('TRUSTED_PROXY_IP_HEADER') || '';
  const parsedHops = Number(Deno.env.get('TRUSTED_PROXY_HOPS') || '');
  const trustedProxyHops = Number.isFinite(parsedHops) && parsedHops >= 1 ? parsedHops : undefined;
  const remoteAddr =
    connInfo?.remoteAddr && typeof connInfo.remoteAddr.hostname === 'string'
      ? connInfo.remoteAddr.hostname
      : undefined;

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
    remoteAddr,
    trustedProxyIpHeader,
    trustedProxyHops,
  });
});
