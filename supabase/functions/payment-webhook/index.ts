// ==============================================================================
// CourtBook / BookSuite — Payment Provider Webhook Ingestion Edge Function
// Endpoint: POST /payment-webhook
//
// Description:
//   Authenticates and processes inbound PayMongo webhooks:
//   1. Reads exact raw request body.
//   2. Validates Paymongo-Signature using server-side HMAC-SHA256 secret.
//   3. Records raw event in append-only provider_webhook_events table.
//   4. Invokes process_verified_payment_event via service_role to reconcile
//      reservation holds, confirm bookings or record customer refund liabilities,
//      and post balanced financial journals.
// ==============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, paymongo-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function verifyPayMongoSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): Promise<{ isValid: boolean; timestamp?: number; error?: string }> {
  if (!signatureHeader || !rawBody || !secret) {
    return { isValid: false, error: 'Missing rawBody, signatureHeader, or secret' };
  }

  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, item) => {
    const [key, value] = item.trim().split('=');
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});

  const timestampStr = parts['t'];
  if (!timestampStr) return { isValid: false, error: 'Missing timestamp' };
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return { isValid: false, error: 'Invalid timestamp' };

  const now = Math.floor(Date.now() / 1000);
  if (toleranceSeconds > 0 && Math.abs(now - timestamp) > toleranceSeconds) {
    return { isValid: false, timestamp, error: 'Timestamp tolerance exceeded' };
  }

  const expectedPayload = `${timestamp}.${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, enc.encode(expectedPayload));
  const computedHex = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const testSig = parts['te'];
  const liveSig = parts['li'];

  if (liveSig && liveSig === computedHex) {
    return { isValid: true, timestamp };
  }
  if (testSig && testSig === computedHex) {
    return { isValid: true, timestamp };
  }

  return { isValid: false, timestamp, error: 'Signature mismatch' };
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

  const rawBody = await req.text();
  const signatureHeader = req.headers.get('paymongo-signature') || req.headers.get('Paymongo-Signature') || '';
  const webhookSecret = Deno.env.get('PAYMONGO_WEBHOOK_SECRET') || '';

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  // Compute SHA-256 payload hash
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(rawBody));
  const payloadHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  let parsedPayload: Record<string, unknown> = {};
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const data = (parsedPayload.data as Record<string, unknown>) || {};
  const attributes = (data.attributes as Record<string, unknown>) || {};
  const eventId = String(data.id || '');
  const eventType = String(attributes.type || '');
  const eventData = (attributes.data as Record<string, unknown>) || {};
  const eventDataAttrs = (eventData.attributes as Record<string, unknown>) || {};

  // Verify HMAC signature
  const verification = await verifyPayMongoSignature(rawBody, signatureHeader, webhookSecret);
  const signatureStatus = verification.isValid ? 'verified' : 'failed';

  // 1. Ingest into append-only provider_webhook_events
  const { data: inboxRecord, error: inboxError } = await supabaseAdmin
    .from('provider_webhook_events')
    .insert({
      provider_name: 'paymongo',
      provider_event_id: eventId || `gen_${crypto.randomUUID()}`,
      event_type: eventType || 'unknown',
      signature_verification_status: signatureStatus,
      signature_header: signatureHeader,
      payload_hash: payloadHash,
      processing_state: verification.isValid ? 'pending' : 'failed',
      last_error: verification.isValid ? null : verification.error,
      payload: parsedPayload,
    })
    .select('id')
    .single();

  let activeInboxId = inboxRecord?.id;

  if (inboxError) {
    if (inboxError.code === '23505') {
      const { data: existingEvent, error: fetchErr } = await supabaseAdmin
        .from('provider_webhook_events')
        .select('id, payload_hash, processing_state')
        .eq('provider_name', 'paymongo')
        .eq('provider_event_id', eventId)
        .single();

      if (fetchErr || !existingEvent) {
        return new Response(JSON.stringify({ error: 'Failed to inspect duplicate webhook event' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (existingEvent.payload_hash !== payloadHash) {
        await supabaseAdmin
          .from('provider_webhook_events')
          .update({ last_error: 'Conflicting payload hash for duplicate provider_event_id' })
          .eq('id', existingEvent.id);

        return new Response(
          JSON.stringify({
            success: false,
            error: 'Conflicting payload hash for duplicate provider_event_id',
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!verification.isValid) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid or forged webhook signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (existingEvent.processing_state === 'processed') {
        return new Response(
          JSON.stringify({
            success: true,
            status: 'already_processed',
            message: 'Duplicate webhook event already processed',
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (existingEvent.processing_state === 'processing') {
        return new Response(
          JSON.stringify({
            success: false,
            status: 'currently_processing',
            retryable: true,
            message: 'Webhook event is currently being processed',
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Stored but unprocessed ('pending' or 'failed'): acquire lease and resume reconciliation
      const { data: leased, error: leaseErr } = await supabaseAdmin
        .from('provider_webhook_events')
        .update({ processing_state: 'processing', last_error: null })
        .eq('id', existingEvent.id)
        .eq('processing_state', existingEvent.processing_state)
        .select('id')
        .single();

      if (leaseErr || !leased) {
        return new Response(
          JSON.stringify({
            success: false,
            status: 'currently_processing',
            retryable: true,
            message: 'Concurrent webhook retry detected',
          }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      activeInboxId = leased.id;
    } else {
      return new Response(JSON.stringify({ error: inboxError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // Reject unverified events
  if (!verification.isValid) {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid or forged webhook signature' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 2. Process verified event if it represents a capture
  const supportedCaptureEvents = new Set([
    'payment.paid',
    'checkout_session.payment.paid',
    'payment.captured',
  ]);

  if (supportedCaptureEvents.has(eventType)) {
    const rawAmount = typeof eventDataAttrs.amount === 'number'
      ? eventDataAttrs.amount
      : (typeof attributes.amount === 'number' ? attributes.amount : 0);
    const capturedAmount = rawAmount > 0 ? rawAmount / 100 : 0;
    const providerPaymentId = String(eventData.id || '').trim();
    const metadata = (eventDataAttrs.metadata as Record<string, unknown>) || {};
    const checkoutSessionId = String(metadata.checkout_session_id || eventDataAttrs.checkout_session_id || '').trim();
    const currency = typeof eventDataAttrs.currency === 'string' ? eventDataAttrs.currency.trim().toUpperCase() : '';
    const paymentStatus = typeof eventDataAttrs.status === 'string' ? eventDataAttrs.status.trim().toLowerCase() : '';

    if (!providerPaymentId || !checkoutSessionId || capturedAmount <= 0 || !currency) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Webhook payload missing mandatory payment identity, checkout session identity, captured amount, or currency.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!['paid', 'succeeded', 'captured'].includes(paymentStatus)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Unsupported or non-terminal payment status: ${paymentStatus || 'missing'}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Enforce PayMongo test/live environment isolation
    const paymongoSecretKey = Deno.env.get('PAYMONGO_SECRET_KEY') || '';
    const isLiveKey = paymongoSecretKey.startsWith('sk_live_');
    const isTestKey = paymongoSecretKey.startsWith('sk_test_');
    if (typeof eventDataAttrs.livemode === 'boolean') {
      if (isLiveKey && !eventDataAttrs.livemode) {
        return new Response(
          JSON.stringify({ success: false, error: 'Environment mismatch: test webhook event rejected in live mode.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (isTestKey && eventDataAttrs.livemode) {
        return new Response(
          JSON.stringify({ success: false, error: 'Environment mismatch: live webhook event rejected in test mode.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const idempotencyKey = `wh_proc_${eventId}_${providerPaymentId}`;

    const { data: processResult, error: processError } = await supabaseAdmin.rpc('process_verified_payment_event', {
      p_webhook_event_id: activeInboxId,
      p_provider_name: 'paymongo',
      p_provider_event_id: eventId,
      p_provider_payment_id: providerPaymentId,
      p_checkout_session_id: checkoutSessionId,
      p_captured_amount: capturedAmount,
      p_currency: currency,
      p_idempotency_key: idempotencyKey,
      p_metadata: { raw_event_type: eventType },
    });

    if (processError) {
      return new Response(JSON.stringify({ error: processError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(processResult), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, status: 'acknowledged' }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
