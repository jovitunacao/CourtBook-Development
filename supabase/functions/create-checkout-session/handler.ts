// ==============================================================================
// LockaCourt (AratReserve) — Create Checkout Session Edge Function Handler
// File: supabase/functions/create-checkout-session/handler.ts
//
// Description:
//   Testable, runtime-agnostic request handler for POST /create-checkout-session:
//   - Enforces strict server-controlled payment provider selection ('paymongo' | 'hitpay')
//   - Rejects unready/prohibited providers ('xendit', 'manual_test', unknown)
//   - Rejects live HitPay config in Stage 2 sandbox mode
//   - Invokes public.create_booking_checkout_session & bind_provider_checkout_session
//   - Guarantees payments.provider_name matches the invoked provider gateway
//   - Never silently falls back from HitPay to PayMongo or simulation
// ==============================================================================

import { mintGuestLookupToken } from '../_shared/guestLookupToken.ts';
import {
  createHitPaySandboxPaymentRequest,
  HitPayConfigError,
  HitPayNotConfiguredError,
  HitPayReconciliationError,
  HitPayValidationError,
  isHitPaySandboxConfigured,
  resolveHitPaySandboxConfig,
  type HitPayFetchLike,
} from '../_shared/hitpay.ts';

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export type ActiveCheckoutProvider = 'paymongo' | 'hitpay';

export interface CreateCheckoutBody {
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
  payment_methods?: string[];
}

export interface SupabaseAdminCheckoutLike {
  rpc: (
    fn: string,
    params?: Record<string, unknown>
  ) => Promise<{ data: any; error: { message?: string; code?: string } | null }>;
}

export interface CreateCheckoutDeps {
  supabaseAdmin: SupabaseAdminCheckoutLike;
  env: Record<string, string | undefined>;
  fetchFn?: HitPayFetchLike;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Server-controlled provider resolution.
 * Never allows clients to force 'xendit', 'manual_test', unknown providers,
 * or any provider disabled/not allowed by server configuration.
 */
export function resolveServerControlledProvider(
  requestedProvider: string | undefined,
  env: Record<string, string | undefined>
): { ok: true; provider: ActiveCheckoutProvider } | { ok: false; status: number; error: string } {
  const forcedRaw = (env.FORCE_PAYMENT_PROVIDER || '').trim().toLowerCase();
  const defaultRaw = (
    forcedRaw ||
    env.ACTIVE_PAYMENT_PROVIDER ||
    env.DEFAULT_PAYMENT_PROVIDER ||
    'paymongo'
  )
    .trim()
    .toLowerCase();

  if (defaultRaw !== 'paymongo' && defaultRaw !== 'hitpay') {
    return {
      ok: false,
      status: 500,
      error: `Server active payment provider "${defaultRaw}" is not ready or supported.`,
    };
  }

  const allowedListRaw = (env.ALLOWED_PAYMENT_PROVIDERS || '').trim().toLowerCase();
  const allowedSet = new Set<string>(
    forcedRaw
      ? [forcedRaw]
      : allowedListRaw
      ? allowedListRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [defaultRaw]
  );
  // Ensure configured default is allowed unless forced overrides it
  if (!forcedRaw && !allowedListRaw) {
    allowedSet.add(defaultRaw);
  }

  const requested = (requestedProvider || '').trim().toLowerCase();
  if (!requested) {
    return { ok: true, provider: defaultRaw as ActiveCheckoutProvider };
  }

  if (requested === 'xendit') {
    return {
      ok: false,
      status: 400,
      error: 'Xendit payment provider adapter is marked NOT READY. Official production integration pending.',
    };
  }

  if (requested === 'manual_test') {
    return {
      ok: false,
      status: 400,
      error: 'Manual test payment provider cannot be selected for public checkout sessions.',
    };
  }

  if (requested !== 'paymongo' && requested !== 'hitpay') {
    return {
      ok: false,
      status: 400,
      error: `Unsupported payment provider "${requested}".`,
    };
  }

  if (!allowedSet.has(requested)) {
    return {
      ok: false,
      status: 400,
      error: `Payment provider "${requested}" is not enabled on this server. Active checkout is controlled server-side.`,
    };
  }

  return { ok: true, provider: requested as ActiveCheckoutProvider };
}

export async function handleCreateCheckoutSessionRequest(
  req: Request,
  deps: CreateCheckoutDeps
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const fetchFn = deps.fetchFn || globalThis.fetch;
  const env = deps.env || {};

  try {
    let body: CreateCheckoutBody;
    try {
      body = (await req.json()) as CreateCheckoutBody;
    } catch {
      return jsonResponse({ error: 'Invalid JSON request payload.' }, 400);
    }

    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Invalid request payload.' }, 400);
    }

    const idempotencyKey = req.headers.get('idempotency-key') || body.idempotency_key;
    if (!idempotencyKey || idempotencyKey.trim().length < 16) {
      return jsonResponse({ error: 'A valid idempotency-key (min 16 chars) is required.' }, 400);
    }
    const cleanIdempotencyKey = idempotencyKey.trim();

    // 1. Server-controlled payment provider selection & readiness check
    const providerResolution = resolveServerControlledProvider(body.provider_name, env);
    if (!providerResolution.ok) {
      return jsonResponse(
        { error: providerResolution.error, is_ready: false },
        providerResolution.status
      );
    }
    const providerName: ActiveCheckoutProvider = providerResolution.provider;

    // Pre-validate HitPay Stage 2 Sandbox configuration BEFORE acquiring reservation hold
    let hitpayConfig: ReturnType<typeof resolveHitPaySandboxConfig> | null = null;
    if (providerName === 'hitpay') {
      try {
        hitpayConfig = resolveHitPaySandboxConfig(env);
        if (!isHitPaySandboxConfigured(hitpayConfig)) {
          return jsonResponse(
            {
              success: false,
              status: 'provider_not_configured',
              code: 'provider_not_configured',
              provider_name: 'hitpay',
              error:
                'provider_not_configured: HitPay sandbox credentials are not configured. Real HitPay checkout is disabled until valid sandbox credentials are provided.',
              is_ready: false,
            },
            503
          );
        }
      } catch (cfgErr: unknown) {
        console.error('[create-checkout-session] HitPay config error:', cfgErr);
        return jsonResponse(
          {
            error:
              cfgErr instanceof HitPayConfigError
                ? cfgErr.message
                : 'HitPay sandbox configuration is invalid.',
            is_ready: false,
          },
          500
        );
      }
    }

    const supabaseUrl = (env.SUPABASE_URL || '').trim();
    const supabaseServiceKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseServiceKey) {
      return jsonResponse({ error: 'Server environment misconfiguration.' }, 500);
    }

    // 2. Call database procedure to initialize hold and compute server-authoritative rates
    const { data, error } = await deps.supabaseAdmin.rpc('create_booking_checkout_session', {
      p_idempotency_key: cleanIdempotencyKey,
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

    if (error || !data) {
      const errMsg = error?.message || '';
      console.error('[create-checkout-session] create_booking_checkout_session RPC error:', errMsg);
      const isConflict =
        errMsg.includes('already reserved') || errMsg.includes('exclusion_violation');
      return jsonResponse(
        {
          success: false,
          error: isConflict
            ? 'Selected court time slot is already reserved. Please select another slot.'
            : 'Unable to initialize checkout for the selected booking details. Please verify your information and try again.',
        },
        isConflict ? 409 : 400
      );
    }

    const lookupSecret = (env.BOOKING_LOOKUP_TOKEN_SECRET || supabaseServiceKey).trim();
    const lookupToken = await mintGuestLookupToken({
      reservationId: String(data.reservation_id),
      referenceCode: String(data.reference_code),
      secret: lookupSecret,
      ttlSeconds: 7200,
    });

    // 3. If already bound and replayed idempotently, return existing session details
    const existingSessionId = String(data.checkout_session_id || '');
    if (
      data.idempotent_replayed &&
      data.checkout_url &&
      existingSessionId &&
      !existingSessionId.startsWith('cs_pending_')
    ) {
      return jsonResponse(
        {
          ...data,
          provider_name: data.provider_name || providerName,
          lookup_token: lookupToken,
        },
        200
      );
    }

    // 4. Create Checkout Session via selected provider adapter
    const appBaseUrl = (env.APP_BASE_URL || 'https://lockacourt.com').trim().replace(/\/+$/, '');
    const amountCentavos = Math.round(Number(data.expected_amount) * 100);
    const successUrl = `${appBaseUrl}/booking/success?ref=${encodeURIComponent(
      String(data.reference_code)
    )}&token=${encodeURIComponent(lookupToken)}`;
    const cancelUrl = `${appBaseUrl}/booking/cancelled?ref=${encodeURIComponent(
      String(data.reference_code)
    )}&token=${encodeURIComponent(lookupToken)}`;
    const checkoutDescription = `LockaCourt: ${data.court_name} (${data.time_slot_label})`;

    let providerCheckoutId: string;
    let checkoutUrl: string;
    let isSimulated = false;

    if (providerName === 'hitpay') {
      const hitpayWebhookUrl = (
        env.HITPAY_WEBHOOK_URL || `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/hitpay-webhook`
      ).trim();

      const allowedPaymentMethods = Array.isArray(body.payment_methods)
        ? body.payment_methods.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        : undefined;

      try {
        const hpRes = await createHitPaySandboxPaymentRequest(
          {
            amountCentavos,
            currency: String(data.currency || 'PHP'),
            description: checkoutDescription,
            customerName: body.customer_name.trim(),
            customerPhone: body.customer_phone?.trim() || undefined,
            customerEmail: body.customer_email?.trim() || undefined,
            referenceCode: String(data.reference_code),
            successUrl,
            webhookUrl: hitpayWebhookUrl,
            paymentMethods: allowedPaymentMethods,
            isIdempotentReplay: Boolean(data.idempotent_replayed),
            existingRequestId:
              existingSessionId && !existingSessionId.startsWith('cs_pending_')
                ? existingSessionId
                : undefined,
          },
          hitpayConfig!,
          fetchFn
        );

        providerCheckoutId = hpRes.providerCheckoutId;
        checkoutUrl = hpRes.checkoutUrl;
        isSimulated = false;
      } catch (hpErr: unknown) {
        if (hpErr instanceof HitPayReconciliationError) {
          return jsonResponse(
            {
              success: false,
              status: 'reconciliation_required',
              provider_name: 'hitpay',
              payment_id: data.payment_id,
              reference_code: data.reference_code,
              error:
                'Checkout session recovery failed or no active HitPay sandbox request found. Booking marked for reconciliation; refusing to create a duplicate payable session.',
            },
            503
          );
        }
        if (hpErr instanceof HitPayNotConfiguredError) {
          return jsonResponse(
            {
              success: false,
              status: 'provider_not_configured',
              code: 'provider_not_configured',
              is_ready: false,
              provider_name: 'hitpay',
              error: hpErr.message,
            },
            503
          );
        }
        if (hpErr instanceof HitPayConfigError) {
          return jsonResponse(
            {
              success: false,
              is_ready: false,
              provider_name: 'hitpay',
              error: hpErr.message,
            },
            500
          );
        }
        if (hpErr instanceof HitPayValidationError) {
          return jsonResponse(
            {
              success: false,
              provider_name: 'hitpay',
              error: hpErr.message,
            },
            400
          );
        }

        console.error('[create-checkout-session] HitPay API error:', hpErr);
        return jsonResponse(
          {
            success: false,
            provider_name: 'hitpay',
            error:
              'HitPay sandbox gateway is temporarily unable to create a checkout session. Please try again shortly.',
          },
          502
        );
      }
    } else {
      // PayMongo Path (preserved cleanly)
      const paymongoSecretKey = (env.PAYMONGO_SECRET_KEY || '').trim();
      const appEnv = env.ENVIRONMENT || env.NODE_ENV || 'development';
      const allowSimulation = env.ALLOW_PAYMENT_SIMULATION === 'true';

      if (paymongoSecretKey.startsWith('sk_live_') || paymongoSecretKey.startsWith('sk_test_')) {
        const authHeader = 'Basic ' + btoa(`${paymongoSecretKey}:`);

        let recoveredExisting = false;
        let recoveredId = '';
        let recoveredUrl = '';

        if (data.idempotent_replayed) {
          try {
            const listRes = await fetchFn('https://api.paymongo.com/v1/checkout_sessions?limit=10', {
              method: 'GET',
              headers: { Authorization: authHeader },
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
                recoveredId = String(matched.id);
                recoveredUrl = String(matched.attributes.checkout_url);
                recoveredExisting = true;
              }
            }
          } catch {
            // Proceed to reconciliation check
          }
        }

        if (!recoveredExisting && data.idempotent_replayed) {
          return jsonResponse(
            {
              success: false,
              status: 'reconciliation_required',
              provider_name: 'paymongo',
              payment_id: data.payment_id,
              reference_code: data.reference_code,
              error:
                'Checkout session recovery failed or no active provider session found. Booking marked for reconciliation; refusing to create a duplicate payable session.',
            },
            503
          );
        }

        if (recoveredExisting) {
          providerCheckoutId = recoveredId;
          checkoutUrl = recoveredUrl;
        } else {
          const pmRes = await fetchFn('https://api.paymongo.com/v1/checkout_sessions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: authHeader,
            },
            body: JSON.stringify({
              data: {
                attributes: {
                  send_email_receipt: true,
                  show_description: true,
                  show_line_items: true,
                  description: checkoutDescription,
                  line_items: [
                    {
                      currency: data.currency,
                      amount: amountCentavos,
                      name: `LockaCourt Court Rental: ${data.court_name}`,
                      quantity: 1,
                    },
                  ],
                  payment_method_types: ['card', 'gcash', 'paymaya', 'grab_pay'],
                  reference_number: data.reference_code,
                  success_url: successUrl,
                  cancel_url: cancelUrl,
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
            const upstreamStatus = pmRes.status;
            const upstreamBody = await pmRes.text().catch(() => '');
            console.error('[create-checkout-session] PayMongo API error:', upstreamStatus, upstreamBody);
            return jsonResponse(
              {
                error:
                  'Payment provider is temporarily unable to create a checkout session. Please try again shortly.',
              },
              502
            );
          }

          const pmJson = await pmRes.json();
          providerCheckoutId = String(pmJson?.data?.id || '');
          checkoutUrl = String(pmJson?.data?.attributes?.checkout_url || '');
        }
      } else {
        if (appEnv === 'production' || !allowSimulation) {
          return jsonResponse(
            {
              error:
                'Missing production PayMongo credentials. Simulation is prohibited in production and requires explicit configuration.',
              is_ready: false,
            },
            500
          );
        }

        isSimulated = true;
        providerCheckoutId = `cs_sandbox_${data.reference_code}`;
        checkoutUrl = `${appBaseUrl}/sandbox/checkout?cs=${providerCheckoutId}&ref=${data.reference_code}`;
      }
    }

    // 5. Bind the returned provider checkout ID strictly matching providerName
    let bindSuccess = false;
    let bindFailureDetail = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data: bindData, error: bindError } = await deps.supabaseAdmin.rpc(
        'bind_provider_checkout_session',
        {
          p_payment_id: data.payment_id,
          p_reservation_id: data.reservation_id,
          p_provider_name: providerName,
          p_checkout_session_id: providerCheckoutId,
          p_checkout_url: checkoutUrl,
          p_idempotency_key: `${cleanIdempotencyKey}_bind`,
          p_metadata: {
            is_simulated: isSimulated,
            provider_name: providerName,
            provider_session_id: providerCheckoutId,
            attempt,
          },
        }
      );

      if (!bindError && bindData?.success) {
        bindSuccess = true;
        break;
      }

      bindFailureDetail = bindError?.message || 'Binding failed';
      if (bindFailureDetail.includes('already bound') || bindData?.status === 'already_bound') {
        bindSuccess = true;
        break;
      }
    }

    if (!bindSuccess) {
      console.error('[create-checkout-session] Checkout session binding failure:', {
        referenceCode: data.reference_code,
        providerName,
        bindFailureDetail,
      });
      return jsonResponse(
        {
          error:
            'Unable to finalize checkout session binding. Please retry to recover your booking hold.',
          reference_code: data.reference_code,
          recovery_instruction:
            'Retry request with same idempotency key to recover bound session without creating duplicate sessions.',
        },
        500
      );
    }

    return jsonResponse(
      {
        ...data,
        provider_name: providerName,
        checkout_session_id: providerCheckoutId,
        checkout_url: checkoutUrl,
        lookup_token: lookupToken,
        is_simulated: isSimulated,
      },
      200
    );
  } catch (err: unknown) {
    console.error('[create-checkout-session] Unhandled exception:', err);
    return jsonResponse(
      { error: 'Unable to initialize checkout session. Please try again.' },
      500
    );
  }
}
