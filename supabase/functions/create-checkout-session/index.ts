// ==============================================================================
// LockaCourt (AratReserve) — Create Checkout Session Edge Function
// Endpoint: POST /create-checkout-session
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import {
  corsHeaders,
  handleCreateCheckoutSessionRequest,
} from './handler.ts';

serve(async (req: Request) => {
  const env = Deno.env.toObject();
  const supabaseUrl = env.SUPABASE_URL || '';
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !supabaseServiceKey) {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }
    return new Response(
      JSON.stringify({ error: 'Server environment misconfiguration.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  return handleCreateCheckoutSessionRequest(req, {
    supabaseAdmin,
    env,
  });
});
