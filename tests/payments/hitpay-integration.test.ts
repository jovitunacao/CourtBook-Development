// ==============================================================================
// LockaCourt (AratReserve) — Stage 2 HitPay Sandbox Integration Test Suite
// File: tests/payments/hitpay-integration.test.ts
//
// Tests:
//   1. Existing PayMongo / Xendit / ManualTest regression suite
//   2. HitPay Sandbox Adapter & shared module (_shared/hitpay.ts)
//      - PHP currency & decimal formatting (no centavos /100 bug)
//      - Live mode / credential / URL / flag rejection
//      - Timeout & 500 GET recovery without duplicate POST
//      - Unrecoverable timeout fail-closed (HitPayReconciliationError)
//   3. create-checkout-session Edge Function handler
//      - Server-controlled provider selection (rejects xendit, manual_test, unauthorized override)
//      - HitPay sandbox request creation + DB provider_name binding consistency
//      - LockaCourt payment descriptions & https://lockacourt.com redirect URLs
//      - Zero silent fallback to PayMongo or simulation on HitPay error
//      - PayMongo checkout path regression parity
//   4. hitpay-webhook Edge Function handler
//      - Raw body HMAC-SHA256 Hitpay-Signature verification
//      - Legacy form-urlencoded callback rejection
//      - Tampered body, forged HMAC, conflicting payload hash, duplicate replay
//      - Live payload rejection in sandbox mode
//      - Authoritative GET /v1/payment-requests/{id} re-verification before DB capture
//      - Verified capture (₱350.00 & ₱12,500.00) + verified charge.updated refund
//   5. get-booking-status & frontend wiring
//      - Confirms HitPay booking via payment_request.completed & charge.created events
//      - PaymentCheckoutBridge renders HitPay vs PayMongo dynamically
//      - Frontend demo isolation preserved with HitPay config present
// ==============================================================================

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runWebhookSignatureTests } from '../supabase/suites/webhook-signature.test';
import { HitPayAdapter } from '../../src/lib/payments/hitpay-adapter';
import { PaymentProviderRegistry } from '../../src/lib/payments/provider-adapter';
import {
  HitPayConfigError,
  HitPayNotConfiguredError,
  HitPayReconciliationError,
  HitPayValidationError,
  assertHitPayPhpCurrency,
  formatCentavosToHitPayDecimal,
  isHitPaySandboxCheckoutUrl,
  parseHitPayDecimalAmount,
  resolveHitPaySandboxConfig,
} from '../../supabase/functions/_shared/hitpay';
import {
  OFFLINE_HITPAY_TEST_API_KEY,
  OFFLINE_HITPAY_TEST_SALT,
  buildMockHitPayPaymentRequestResponse,
  buildSignedHitPayWebhookFixture,
  signOfflineHitPayWebhookBody,
} from './hitpay-fixtures';
import { handleCreateCheckoutSessionRequest } from '../../supabase/functions/create-checkout-session/handler';
import { handleHitPayWebhookRequest } from '../../supabase/functions/hitpay-webhook/handler';
import { handleGetBookingStatusRequest } from '../../supabase/functions/get-booking-status/handler';
import { mintGuestLookupToken } from '../../supabase/functions/_shared/guestLookupToken';
import { createBookingCheckoutSession, verifyPublicBookingPaymentStatus } from '../../src/lib/supabaseClient';
import { PaymentCheckoutBridge } from '../../src/components/booking/PaymentCheckoutBridge';

const TEST_SALT = OFFLINE_HITPAY_TEST_SALT;
const TEST_API_KEY = OFFLINE_HITPAY_TEST_API_KEY;
const TEST_SECRET = 'super-secret-booking-lookup-signing-key-2026';

function signHitPayBody(rawBody: string, salt: string = TEST_SALT): string {
  return signOfflineHitPayWebhookBody(rawBody, salt);
}

let passed = 0;

// ==============================================================================
// Suite 1: Existing PayMongo, Xendit & ManualTest Signature/Adapter Tests
// ==============================================================================
{
  const res = await runWebhookSignatureTests();
  assert.equal(res.failed, 0, `Existing webhook signature tests failed: ${res.errors.join('; ')}`);
  assert.ok(res.passed >= 11, 'Expected at least 11 existing signature/adapter tests to pass');
  passed++;
  console.log(`✓ Suite 1: Existing PayMongo & Provider Registry regression suite passed (${res.passed} checks)`);
}

// ==============================================================================
// Suite 2: HitPay Adapter & Sandbox Shared Module Unit Tests
// ==============================================================================
{
  assert.equal(assertHitPayPhpCurrency('PHP'), 'PHP');
  assert.equal(assertHitPayPhpCurrency('₱'), 'PHP');
  assert.throws(() => assertHitPayPhpCurrency('USD'), HitPayValidationError);

  assert.equal(formatCentavosToHitPayDecimal(35000), '350.00');
  assert.equal(formatCentavosToHitPayDecimal(1250050), '12500.50');
  assert.throws(() => formatCentavosToHitPayDecimal(0), HitPayValidationError);
  assert.throws(() => formatCentavosToHitPayDecimal(350.5), HitPayValidationError);

  assert.equal(parseHitPayDecimalAmount('350.00'), 350);
  assert.equal(parseHitPayDecimalAmount('12500.00'), 12500); // Never / 100!
  assert.equal(parseHitPayDecimalAmount('0'), null);

  assert.equal(isHitPaySandboxCheckoutUrl('https://securecheckout.sandbox.hit-pay.com/payment-request/@test/abc'), true);
  assert.equal(isHitPaySandboxCheckoutUrl('https://sandbox.hit-pay.com/pay/abc'), true);
  assert.equal(isHitPaySandboxCheckoutUrl('https://securecheckout.hit-pay.com/payment-request/@test/abc'), false);
  assert.equal(isHitPaySandboxCheckoutUrl('http://sandbox.hit-pay.com/pay/abc'), false);

  // Reject live HitPay configuration flags & URLs
  assert.throws(() => resolveHitPaySandboxConfig({ HITPAY_ENV: 'production' }), HitPayConfigError);
  assert.throws(() => resolveHitPaySandboxConfig({ HITPAY_ENV: 'live' }), HitPayConfigError);
  assert.throws(() => resolveHitPaySandboxConfig({ HITPAY_ENV: 'sandbox', HITPAY_ALLOW_LIVE: 'true' }), HitPayConfigError);
  assert.throws(() => resolveHitPaySandboxConfig({ HITPAY_ENV: 'sandbox', HITPAY_LIVE_API_KEY: 'abc' }), HitPayConfigError);
  assert.throws(
    () => resolveHitPaySandboxConfig({ HITPAY_ENV: 'sandbox', HITPAY_SANDBOX_API_URL: 'https://api.hit-pay.com' }),
    HitPayConfigError
  );
  assert.throws(
    () => resolveHitPaySandboxConfig({ HITPAY_ENV: 'sandbox', HITPAY_SANDBOX_API_KEY: 'live_abc123' }),
    HitPayConfigError
  );

  // Optional during dev/offline: resolveHitPaySandboxConfig succeeds with empty credentials & isConfigured=false
  const emptyCfg = resolveHitPaySandboxConfig({});
  assert.equal(emptyCfg.environment, 'sandbox');
  assert.equal(emptyCfg.apiKey, '');
  assert.equal(emptyCfg.webhookSalt, '');
  assert.equal(emptyCfg.isConfigured, false);

  // Unconfigured HitPayAdapter reports isConfigured() === false & fails closed with provider_not_configured
  let unconfiguredFetchCalls = 0;
  const unconfiguredAdapter = new HitPayAdapter({
    env: {},
    fetchFn: async () => {
      unconfiguredFetchCalls++;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(unconfiguredAdapter.isConfigured(), false);
  await assert.rejects(
    () =>
      unconfiguredAdapter.createCheckoutSession({
        amountCentavos: 35000,
        currency: 'PHP',
        description: 'LockaCourt: Court A',
        customerName: 'Juan Dela Cruz',
        referenceCode: 'CB-UNCONF-001',
        successUrl: 'https://lockacourt.com/booking/success',
        cancelUrl: 'https://lockacourt.com/booking/cancelled',
      }),
    (err: unknown) => err instanceof HitPayNotConfiguredError && err.code === 'provider_not_configured'
  );
  assert.equal(unconfiguredFetchCalls, 0, 'Must never call HitPay API when credentials are unconfigured');

  // Registry returns HitPayAdapter
  const regAdapter = PaymentProviderRegistry.getAdapter('hitpay');
  assert.equal(regAdapter.providerName, 'hitpay');
  assert.equal(regAdapter.isReady, true);

  // Successful createCheckoutSession request contract
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];
  const hpAdapter = new HitPayAdapter({
    env: { HITPAY_ENV: 'sandbox', HITPAY_SANDBOX_API_KEY: TEST_API_KEY, HITPAY_SANDBOX_WEBHOOK_SALT: TEST_SALT },
    fetchFn: async (url, init) => {
      const hdrs: Record<string, string> = {};
      if (init?.headers && typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          hdrs[k] = v;
        }
      }
      calls.push({
        url: String(url),
        method: init?.method || 'GET',
        headers: hdrs,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({
          id: 'req_hp_sandbox_001',
          url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@lockacourt/req_hp_sandbox_001',
          status: 'pending',
          amount: '12500.00',
          currency: 'PHP',
          reference_number: 'CB-HP-12500',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const hpSession = await hpAdapter.createCheckoutSession({
    amountCentavos: 1250000,
    currency: 'PHP',
    description: 'LockaCourt: Center Court (6:00 PM – 8:00 PM)',
    customerName: 'Maria Santos',
    customerPhone: '09171234567',
    customerEmail: 'maria@example.com',
    referenceCode: 'CB-HP-12500',
    successUrl: 'https://lockacourt.com/booking/success?ref=CB-HP-12500',
    cancelUrl: 'https://lockacourt.com/booking/cancelled?ref=CB-HP-12500',
    webhookUrl: 'https://example.supabase.co/functions/v1/hitpay-webhook',
  });

  assert.equal(hpSession.isSimulated, false);
  assert.equal(hpSession.providerCheckoutId, 'req_hp_sandbox_001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sandbox.hit-pay.com/v1/payment-requests');
  assert.equal(calls[0].headers['X-BUSINESS-API-KEY'], TEST_API_KEY);
  assert.equal(calls[0].headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(calls[0].body.amount, '12500.00');
  assert.equal(calls[0].body.currency, 'PHP');
  assert.equal(calls[0].body.reference_number, 'CB-HP-12500');
  assert.equal(calls[0].body.allow_repeated_payments, false);

  // Timeout recovery via GET without issuing duplicate POST
  let postAttempts = 0;
  let getAttempts = 0;
  const recoveringAdapter = new HitPayAdapter({
    env: { HITPAY_ENV: 'sandbox', HITPAY_SANDBOX_API_KEY: TEST_API_KEY },
    fetchFn: async (url, init) => {
      if ((init?.method || 'GET') === 'POST') {
        postAttempts++;
        throw new Error('Request aborted / network timeout');
      }
      getAttempts++;
      assert.ok(String(url).includes('/v1/payment-requests?search=CB-RECOVER-001'));
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'req_hp_recovered_001',
              url: 'https://sandbox.hit-pay.com/pay/req_hp_recovered_001',
              status: 'pending',
              amount: '350.00',
              currency: 'PHP',
              reference_number: 'CB-RECOVER-001',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const recoveredSession = await recoveringAdapter.createCheckoutSession({
    amountCentavos: 35000,
    currency: 'PHP',
    description: 'LockaCourt: Court A',
    customerName: 'Juan Dela Cruz',
    referenceCode: 'CB-RECOVER-001',
    successUrl: 'https://lockacourt.com/booking/success',
    cancelUrl: 'https://lockacourt.com/booking/cancelled',
  });
  assert.equal(postAttempts, 1, 'Must never issue a second blind POST on timeout');
  assert.equal(getAttempts, 1, 'Must execute safe read-only GET recovery on timeout');
  assert.equal(recoveredSession.providerCheckoutId, 'req_hp_recovered_001');

  // Unrecoverable timeout fails closed with HitPayReconciliationError
  const failClosedAdapter = new HitPayAdapter({
    env: { HITPAY_ENV: 'sandbox', HITPAY_SANDBOX_API_KEY: TEST_API_KEY },
    fetchFn: async (_url, init) => {
      if ((init?.method || 'GET') === 'POST') {
        return new Response('Upstream error', { status: 504 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });
  await assert.rejects(
    () =>
      failClosedAdapter.createCheckoutSession({
        amountCentavos: 35000,
        currency: 'PHP',
        description: 'LockaCourt: Court A',
        customerName: 'Juan Dela Cruz',
        referenceCode: 'CB-RECON-001',
        successUrl: 'https://lockacourt.com/booking/success',
        cancelUrl: 'https://lockacourt.com/booking/cancelled',
      }),
    HitPayReconciliationError
  );

  // Sync HMAC signature check
  const sampleWhBody = JSON.stringify({ id: 'req_1', status: 'completed', amount: '350.00', currency: 'PHP' });
  const sig = signHitPayBody(sampleWhBody);
  assert.equal(hpAdapter.verifyWebhookSignature(sampleWhBody, sig, TEST_SALT).isValid, true);
  assert.equal(hpAdapter.verifyWebhookSignature(sampleWhBody + ' ', sig, TEST_SALT).isValid, false);
  assert.equal(hpAdapter.verifyWebhookSignature(sampleWhBody, '0'.repeat(64), TEST_SALT).isValid, false);

  passed++;
  console.log('✓ Suite 2: HitPay Adapter & shared module unit tests passed');
}

// ==============================================================================
// Suite 3: create-checkout-session Edge Function Handler Tests
// ==============================================================================
{
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const mockSupabaseAdmin = {
    rpc: async (fn: string, params: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, params });
      if (fn === 'create_booking_checkout_session') {
        return {
          data: {
            success: true,
            reservation_id: '11111111-1111-4111-8111-111111111111',
            payment_id: '22222222-2222-4222-8222-222222222222',
            reference_code: 'CB-HP-EDGE01',
            provider_name: params.p_provider_name,
            checkout_session_id: 'cs_pending_22222222',
            expected_amount: 350,
            currency: 'PHP',
            commission_rate: 0.05,
            commission_amount: 17.5,
            owner_gross_share: 332.5,
            hold_expires_at: new Date(Date.now() + 900_000).toISOString(),
            time_slot_label: '09:00 AM – 10:00 AM',
            court_name: 'Court 1',
            idempotent_replayed: false,
          },
          error: null,
        };
      }
      if (fn === 'bind_provider_checkout_session') {
        return {
          data: {
            success: true,
            provider_name: params.p_provider_name,
            checkout_session_id: params.p_checkout_session_id,
            status: 'bound',
          },
          error: null,
        };
      }
      return { data: null, error: { message: `Unexpected RPC: ${fn}` } };
    },
  };

  const baseEnv: Record<string, string | undefined> = {
    SUPABASE_URL: 'https://test-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
    BOOKING_LOOKUP_TOKEN_SECRET: TEST_SECRET,
    ACTIVE_PAYMENT_PROVIDER: 'hitpay',
    HITPAY_ENV: 'sandbox',
    HITPAY_SANDBOX_API_KEY: TEST_API_KEY,
    HITPAY_SANDBOX_WEBHOOK_SALT: TEST_SALT,
  };

  const validBody = {
    facility_id: '33333333-3333-4333-8333-333333333333',
    court_id: '44444444-4444-4444-8444-444444444444',
    customer_name: 'Juan Dela Cruz',
    customer_phone: '09171234567',
    customer_email: 'juan@example.com',
    booking_date: '2026-12-01',
    start_time: '2026-12-01T01:00:00Z',
    duration_minutes: 60,
    idempotency_key: 'idem_hitpay_edge_test_001',
  };

  // 3A: Omitted provider_name resolves server-side to HitPay + binds provider_name='hitpay' + LockaCourt URL
  let capturedHitPayBody: any = null;
  const okRes = await handleCreateCheckoutSessionRequest(
    new Request('https://lockacourt.com/functions/v1/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    }),
    {
      supabaseAdmin: mockSupabaseAdmin,
      env: baseEnv,
      fetchFn: async (_url, init) => {
        capturedHitPayBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: 'req_hp_edge_001',
            url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@lockacourt/req_hp_edge_001',
            status: 'pending',
            amount: '350.00',
            currency: 'PHP',
            reference_number: 'CB-HP-EDGE01',
          }),
          { status: 201 }
        );
      },
    }
  );
  assert.equal(okRes.status, 200);
  const okJson = await okRes.json();
  assert.equal(okJson.provider_name, 'hitpay');
  assert.equal(okJson.is_simulated, false);
  assert.equal(okJson.checkout_session_id, 'req_hp_edge_001');
  assert.ok(okJson.checkout_url.includes('sandbox.hit-pay.com'));
  assert.ok(capturedHitPayBody.purpose.startsWith('LockaCourt:'));
  assert.ok(capturedHitPayBody.redirect_url.startsWith('https://lockacourt.com/booking/success'));
  assert.equal(capturedHitPayBody.webhook, 'https://test-project.supabase.co/functions/v1/hitpay-webhook');
  assert.equal(rpcCalls[0].params.p_provider_name, 'hitpay');
  assert.equal(rpcCalls[1].params.p_provider_name, 'hitpay');

  // 3B: Rejects client forcing xendit, manual_test, unknown, or disallowed paymongo
  for (const badProvider of ['xendit', 'manual_test', 'stripe', 'paymongo']) {
    const countBefore = rpcCalls.length;
    const rejRes = await handleCreateCheckoutSessionRequest(
      new Request('https://lockacourt.com/functions/v1/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, provider_name: badProvider }),
      }),
      { supabaseAdmin: mockSupabaseAdmin, env: baseEnv }
    );
    assert.equal(rejRes.status, 400, `Provider "${badProvider}" must be rejected`);
    const rejJson = await rejRes.json();
    assert.equal(rejJson.is_ready, false);
    assert.equal(rpcCalls.length, countBefore, 'Rejected provider must NOT lock a DB reservation slot');
  }

  // 3C: Live HitPay config fails closed BEFORE creating hold
  const countBeforeLive = rpcCalls.length;
  const liveCfgRes = await handleCreateCheckoutSessionRequest(
    new Request('https://lockacourt.com/functions/v1/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    }),
    {
      supabaseAdmin: mockSupabaseAdmin,
      env: { ...baseEnv, HITPAY_ENV: 'live' },
    }
  );
  assert.equal(liveCfgRes.status, 500);
  assert.equal(rpcCalls.length, countBeforeLive, 'Live HitPay config must fail closed before DB hold');

  // 3D: HitPay upstream failure does NOT fall back to PayMongo or simulation
  const failGatewayRes = await handleCreateCheckoutSessionRequest(
    new Request('https://lockacourt.com/functions/v1/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    }),
    {
      supabaseAdmin: mockSupabaseAdmin,
      env: { ...baseEnv, ALLOW_PAYMENT_SIMULATION: 'true', PAYMONGO_SECRET_KEY: 'sk_test_123456' },
      fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 503 }),
    }
  );
  assert.equal(failGatewayRes.status, 503);
  const failGatewayJson = await failGatewayRes.json();
  assert.equal(failGatewayJson.status, 'reconciliation_required');
  assert.equal(failGatewayJson.is_simulated, undefined);

  // 3E: Missing HITPAY_SANDBOX_API_KEY or HITPAY_SANDBOX_WEBHOOK_SALT returns clear provider_not_configured
  // without creating a DB hold/payable session and without falling back to PayMongo or simulation
  for (const partialEnv of [
    {
      SUPABASE_URL: baseEnv.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: baseEnv.SUPABASE_SERVICE_ROLE_KEY,
      ACTIVE_PAYMENT_PROVIDER: 'hitpay',
      PAYMONGO_SECRET_KEY: 'sk_test_mock_key_001',
      ALLOW_PAYMENT_SIMULATION: 'true',
    },
    {
      SUPABASE_URL: baseEnv.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: baseEnv.SUPABASE_SERVICE_ROLE_KEY,
      ACTIVE_PAYMENT_PROVIDER: 'hitpay',
      HITPAY_SANDBOX_API_KEY: TEST_API_KEY,
      // Missing HITPAY_SANDBOX_WEBHOOK_SALT
    },
    {
      SUPABASE_URL: baseEnv.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: baseEnv.SUPABASE_SERVICE_ROLE_KEY,
      ACTIVE_PAYMENT_PROVIDER: 'hitpay',
      HITPAY_SANDBOX_WEBHOOK_SALT: TEST_SALT,
      // Missing HITPAY_SANDBOX_API_KEY
    },
  ]) {
    const rpcBefore = rpcCalls.length;
    let fetchCalls = 0;
    const notCfgRes = await handleCreateCheckoutSessionRequest(
      new Request('https://lockacourt.com/functions/v1/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }),
      {
        supabaseAdmin: mockSupabaseAdmin,
        env: partialEnv,
        fetchFn: async () => {
          fetchCalls++;
          return new Response('{}', { status: 200 });
        },
      }
    );
    assert.equal(notCfgRes.status, 503);
    const notCfgJson = await notCfgRes.json();
    assert.equal(notCfgJson.success, false);
    assert.equal(notCfgJson.code, 'provider_not_configured');
    assert.equal(notCfgJson.status, 'provider_not_configured');
    assert.equal(notCfgJson.provider_name, 'hitpay');
    assert.equal(notCfgJson.is_ready, false);
    assert.equal(notCfgJson.checkout_url, undefined);
    assert.equal(notCfgJson.checkout_session_id, undefined);
    assert.equal(notCfgJson.is_simulated, undefined);
    assert.equal(rpcCalls.length, rpcBefore, 'Must NOT acquire DB slot hold or create payable session when HitPay is unconfigured');
    assert.equal(fetchCalls, 0, 'Must NOT call HitPay or PayMongo when HitPay is unconfigured');
  }

  // 3F: PayMongo remains operational when HitPay credentials are completely omitted
  const pmRes = await handleCreateCheckoutSessionRequest(
    new Request('https://lockacourt.com/functions/v1/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    }),
    {
      supabaseAdmin: mockSupabaseAdmin,
      env: {
        SUPABASE_URL: baseEnv.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: baseEnv.SUPABASE_SERVICE_ROLE_KEY,
        BOOKING_LOOKUP_TOKEN_SECRET: TEST_SECRET,
        ACTIVE_PAYMENT_PROVIDER: 'paymongo',
        PAYMONGO_SECRET_KEY: 'sk_test_mock_key_001',
      },
      fetchFn: async (url) => {
        assert.ok(String(url).includes('api.paymongo.com'));
        return new Response(
          JSON.stringify({
            data: { id: 'cs_test_pm_001', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_test_pm_001' } },
          }),
          { status: 200 }
        );
      },
    }
  );
  assert.equal(pmRes.status, 200);
  const pmJson = await pmRes.json();
  assert.equal(pmJson.provider_name, 'paymongo');
  assert.equal(pmJson.checkout_session_id, 'cs_test_pm_001');

  passed++;
  console.log('✓ Suite 3: create-checkout-session server-controlled provider & HitPay isolation passed');
}

// ==============================================================================
// Suite 4: hitpay-webhook Edge Function Handler Security Tests
// ==============================================================================
{
  const inboxRows = new Map<string, any>();
  const processedRpcs: Array<{ fn: string; params: Record<string, unknown> }> = [];
  let rowSeq = 1;

  const mockWebhookDb = {
    from: (table: string) => {
      if (table === 'provider_webhook_events') {
        return {
          insert: (row: any) => ({
            select: () => ({
              single: async () => {
                const key = `${row.provider_name}:${row.provider_event_id}`;
                if (inboxRows.has(key)) {
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                }
                const id = `wh-${rowSeq++}`;
                const stored = { id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
                inboxRows.set(key, stored);
                return { data: { id }, error: null };
              },
            }),
          }),
          select: () => {
            const filters: Record<string, unknown> = {};
            const chain: any = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              single: async () => {
                for (const row of inboxRows.values()) {
                  if (
                    (!filters.id || row.id === filters.id) &&
                    (!filters.provider_name || row.provider_name === filters.provider_name) &&
                    (!filters.provider_event_id || row.provider_event_id === filters.provider_event_id)
                  ) {
                    return { data: row, error: null };
                  }
                }
                return { data: null, error: { message: 'Not found' } };
              },
            };
            return chain;
          },
          update: (patch: any) => {
            const filters: Record<string, unknown> = {};
            const execUpdate = () => {
              for (const row of inboxRows.values()) {
                if (
                  (!filters.id || row.id === filters.id) &&
                  (!filters.processing_state || row.processing_state === filters.processing_state)
                ) {
                  Object.assign(row, patch);
                  return { data: row, error: null };
                }
              }
              return { data: null, error: { message: 'No row updated' } };
            };
            const chain: any = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              select: () => ({
                single: async () => execUpdate(),
              }),
              then: (resolve: any) => resolve(execUpdate()),
            };
            return chain;
          },
        };
      }
      if (table === 'payments') {
        return {
          select: () => {
            const filters: Record<string, unknown> = {};
            const chain: any = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              },
              maybeSingle: async () => {
                if (filters.provider_payment_id === 'chg_hp_12500') {
                  return { data: { id: 'pay-hp-12500' }, error: null };
                }
                return { data: null, error: null };
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: async (fn: string, params: Record<string, unknown> = {}) => {
      processedRpcs.push({ fn, params });
      for (const row of inboxRows.values()) {
        if (row.id === params.p_webhook_event_id) {
          row.processing_state = 'processed';
        }
      }
      return {
        data: { success: true, outcome: fn === 'process_verified_refund_event' ? 'refunded' : 'confirmed_and_settled' },
        error: null,
      };
    },
  };

  const whEnv = {
    HITPAY_ENV: 'sandbox',
    HITPAY_SANDBOX_API_KEY: TEST_API_KEY,
    HITPAY_SANDBOX_WEBHOOK_SALT: TEST_SALT,
  };

  // 4A-0: Missing HitPay credentials returns clear 503 provider_not_configured without bypassing verification
  const whUnconfFixture = buildSignedHitPayWebhookFixture({
    id: 'req_hp_unconf',
    paymentId: 'chg_hp_unconf',
    status: 'completed',
    amount: '350.00',
    referenceNumber: 'CB-HP-UNCONF',
    eventTypeHeader: 'completed',
    eventObjectHeader: 'payment_request',
  });
  const unconfWhRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: whUnconfFixture.headers,
      body: whUnconfFixture.rawBody,
    }),
    { supabaseAdmin: mockWebhookDb, env: { HITPAY_ENV: 'sandbox' } }
  );
  assert.equal(unconfWhRes.status, 503);
  const unconfWhJson = await unconfWhRes.json();
  assert.equal(unconfWhJson.success, false);
  assert.equal(unconfWhJson.code, 'provider_not_configured');
  assert.equal(unconfWhJson.status, 'provider_not_configured');
  assert.equal(unconfWhJson.is_ready, false);
  assert.equal(inboxRows.size, 0, 'Must NOT insert or process webhook when HitPay credentials are unconfigured');

  // 4A: Reject legacy form-urlencoded webhook callback
  const formRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'payment_id=123&status=completed',
    }),
    { supabaseAdmin: mockWebhookDb, env: whEnv }
  );
  assert.equal(formRes.status, 400);

  // 4B: Signed offline webhook fixture triggers mocked GET /v1/payment-requests/{id} re-check & confirms ₱12,500.00
  const whFixture12k = buildSignedHitPayWebhookFixture({
    id: 'req_hp_12500',
    paymentId: 'chg_hp_12500',
    status: 'completed',
    amount: '12500.00',
    referenceNumber: 'CB-HP-12500',
    eventTypeHeader: 'completed',
    eventObjectHeader: 'payment_request',
  });
  const validWhBody = whFixture12k.rawBody;
  const validSig = whFixture12k.signature;

  let getRecheckCount = 0;
  const whOk = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: whFixture12k.headers,
      body: validWhBody,
    }),
    {
      supabaseAdmin: mockWebhookDb,
      env: whEnv,
      fetchFn: async (url, init) => {
        getRecheckCount++;
        assert.equal(init?.method || 'GET', 'GET');
        assert.equal(String(url), 'https://api.sandbox.hit-pay.com/v1/payment-requests/req_hp_12500');
        return new Response(
          JSON.stringify(
            buildMockHitPayPaymentRequestResponse({
              id: 'req_hp_12500',
              status: 'completed',
              amount: '12500.00',
              reference_number: 'CB-HP-12500',
            })
          ),
          { status: 200 }
        );
      },
    }
  );
  assert.equal(whOk.status, 200);
  assert.equal(getRecheckCount, 1);
  assert.equal(processedRpcs.length, 1);
  assert.equal(processedRpcs[0].fn, 'process_verified_payment_event');
  assert.equal(processedRpcs[0].params.p_provider_name, 'hitpay');
  assert.equal(processedRpcs[0].params.p_captured_amount, 12500);
  assert.equal(processedRpcs[0].params.p_checkout_session_id, 'req_hp_12500');

  // 4C: Duplicate webhook replay returns already_processed without re-calling RPC
  const whReplay = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Hitpay-Signature': validSig,
        'Hitpay-Event-Type': 'completed',
        'Hitpay-Event-Object': 'payment_request',
      },
      body: validWhBody,
    }),
    { supabaseAdmin: mockWebhookDb, env: whEnv }
  );
  assert.equal(whReplay.status, 200);
  const replayJson = await whReplay.json();
  assert.equal(replayJson.status, 'already_processed');
  assert.equal(processedRpcs.length, 1);

  // 4D: Conflicting payload_hash with same provider_event_id returns 409
  const conflictBody = JSON.stringify({
    id: 'req_hp_12500',
    payment_id: 'chg_hp_12500',
    payment_request_id: 'req_hp_12500',
    status: 'completed',
    amount: '99999.00',
    currency: 'PHP',
    reference_number: 'CB-HP-12500',
  });
  const conflictRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Hitpay-Signature': signHitPayBody(conflictBody),
        'Hitpay-Event-Type': 'completed',
        'Hitpay-Event-Object': 'payment_request',
      },
      body: conflictBody,
    }),
    { supabaseAdmin: mockWebhookDb, env: whEnv }
  );
  assert.equal(conflictRes.status, 409);

  // 4E: Forged signature returns 401 and executes ZERO financial RPCs
  const forgedBody = JSON.stringify({
    id: 'req_hp_forged',
    payment_id: 'chg_forged',
    status: 'completed',
    amount: '350.00',
    currency: 'PHP',
  });
  const forgedRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Hitpay-Signature': 'f'.repeat(64) },
      body: forgedBody,
    }),
    { supabaseAdmin: mockWebhookDb, env: whEnv }
  );
  assert.equal(forgedRes.status, 401);
  assert.equal(processedRpcs.length, 1);

  // 4F: Signed live payload rejected in sandbox mode (400) with zero financial RPC
  const liveWhBody = JSON.stringify({
    id: 'req_hp_live_evt',
    payment_id: 'chg_hp_live',
    status: 'completed',
    amount: '350.00',
    currency: 'PHP',
    url: 'https://securecheckout.hit-pay.com/payment-request/@live/req_hp_live_evt',
  });
  const liveWhRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Hitpay-Signature': signHitPayBody(liveWhBody) },
      body: liveWhBody,
    }),
    { supabaseAdmin: mockWebhookDb, env: whEnv }
  );
  assert.equal(liveWhRes.status, 400);
  assert.equal(processedRpcs.length, 1);

  // 4G: Authoritative GET returning 'pending' rejects capture (400) with zero financial RPC
  const spoofingBody = JSON.stringify({
    id: 'req_hp_still_pending',
    payment_id: 'chg_hp_fake',
    status: 'completed',
    amount: '350.00',
    currency: 'PHP',
  });
  const spoofingRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Hitpay-Signature': signHitPayBody(spoofingBody) },
      body: spoofingBody,
    }),
    {
      supabaseAdmin: mockWebhookDb,
      env: whEnv,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            id: 'req_hp_still_pending',
            url: 'https://sandbox.hit-pay.com/pay/req_hp_still_pending',
            status: 'pending',
            amount: '350.00',
            currency: 'PHP',
          }),
          { status: 200 }
        ),
    }
  );
  assert.equal(spoofingRes.status, 400);
  assert.equal(processedRpcs.length, 1);

  // 4H: Verified HitPay refund webhook ('charge.updated') invokes process_verified_refund_event
  const refundBody = JSON.stringify({
    event_id: 'evt_hp_refund_001',
    id: 'ref_hp_001',
    payment_id: 'chg_hp_12500',
    payment_request_id: 'req_hp_12500',
    status: 'refunded',
    amount: '12500.00',
    currency: 'PHP',
  });
  const refundRes = await handleHitPayWebhookRequest(
    new Request('https://lockacourt.com/functions/v1/hitpay-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Hitpay-Signature': signHitPayBody(refundBody),
        'Hitpay-Event-Type': 'updated',
        'Hitpay-Event-Object': 'charge',
      },
      body: refundBody,
    }),
    { supabaseAdmin: mockWebhookDb, env: whEnv }
  );
  assert.equal(refundRes.status, 200);
  assert.equal(processedRpcs.length, 2);
  assert.equal(processedRpcs[1].fn, 'process_verified_refund_event');
  assert.equal(processedRpcs[1].params.p_refund_amount, 12500);

  passed++;
  console.log('✓ Suite 4: hitpay-webhook raw-body HMAC, replay safety & authoritative GET verification passed');
}

// ==============================================================================
// Suite 5: get-booking-status & Frontend HitPay Integration Tests
// ==============================================================================
{
  const RES_ID = '55555555-5555-4555-8555-555555555555';
  const FAC_ID = '66666666-6666-4666-8666-666666666666';
  const ORG_ID = '77777777-7777-4777-8777-777777777777';
  const COURT_ID = '88888888-8888-4888-8888-888888888888';
  const PAY_ID = '99999999-9999-4999-8999-999999999999';
  const WH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const REF_CODE = 'CB-HP-STATUS1';

  const mockStatusAdmin = {
    rpc: async () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null }),
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: async () => {
          if (table === 'payments') {
            return {
              data: [
                {
                  id: PAY_ID,
                  organization_id: ORG_ID,
                  facility_id: FAC_ID,
                  reservation_id: RES_ID,
                  status: 'captured',
                  currency: 'PHP',
                  expected_amount: 350,
                  captured_amount: 350,
                  provider_name: 'hitpay',
                  provider_payment_id: 'chg_hp_status_001',
                  checkout_session_id: 'req_hp_status_001',
                  captured_at: '2026-12-01T01:05:00.000Z',
                  verified_capture_evidence: {
                    webhook_event_id: WH_ID,
                    provider_event_id: 'hp_pr_req_hp_status_001_payment_request.completed',
                    captured_at: '2026-12-01T01:05:00.000Z',
                  },
                },
              ],
              error: null,
            };
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          if (table === 'reservations') {
            return {
              data: {
                id: RES_ID,
                facility_id: FAC_ID,
                court_id: COURT_ID,
                reference_code: REF_CODE,
                customer_name: 'Juan Dela Cruz',
                customer_phone: '09171234567',
                customer_email: 'juan@example.com',
                booking_date: '2026-12-01',
                time_slot_label: '09:00 AM – 10:00 AM',
                duration_minutes: 60,
                price: 350,
                currency: '₱',
                status: 'confirmed',
                is_demo: false,
                hold_expires_at: new Date(Date.now() + 600_000).toISOString(),
              },
              error: null,
            };
          }
          if (table === 'facilities') {
            return {
              data: { id: FAC_ID, organization_id: ORG_ID, name: 'LockaCourt Arena', address: 'Makati' },
              error: null,
            };
          }
          if (table === 'courts') {
            return {
              data: { id: COURT_ID, name: 'Court 1', sport_type: 'Pickleball', facility_id: FAC_ID },
              error: null,
            };
          }
          if (table === 'provider_webhook_events') {
            return {
              data: {
                id: WH_ID,
                provider_name: 'hitpay',
                provider_event_id: 'hp_pr_req_hp_status_001_payment_request.completed',
                event_type: 'payment_request.completed',
                signature_verification_status: 'verified',
                processing_state: 'processed',
              },
              error: null,
            };
          }
          if (table === 'financial_transactions') {
            return {
              data: {
                id: 'tx-hp-001',
                transaction_number: 'TX-HP-001',
                organization_id: ORG_ID,
                facility_id: FAC_ID,
                transaction_type: 'booking_settlement',
                reference_id: RES_ID,
                metadata: {
                  webhook_event_id: WH_ID,
                  provider_payment_id: 'chg_hp_status_001',
                  checkout_session_id: 'req_hp_status_001',
                  reservation_id: RES_ID,
                  gross_amount: 350,
                },
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };

  const token = await mintGuestLookupToken({
    reservationId: RES_ID,
    referenceCode: REF_CODE,
    secret: TEST_SECRET,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const req = new Request(String(url), {
      method: opts?.method || 'POST',
      headers: opts?.headers || { 'Content-Type': 'application/json' },
      body: opts?.body,
    });
    return handleGetBookingStatusRequest(req, {
      supabaseAdmin: mockStatusAdmin,
      lookupSecret: TEST_SECRET,
      remoteAddr: '203.0.113.50',
    });
  };

  try {
    const statusRes = await verifyPublicBookingPaymentStatus({
      reference_code: REF_CODE,
      lookup_token: token,
    });
    assert.equal(statusRes.verified, true);
    assert.equal(statusRes.status, 'confirmed');
    assert.equal(statusRes.provider_name, 'hitpay');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // PaymentCheckoutBridge renders HitPay Official Checkout for HitPay sessions
  const hitpayHtml = renderToStaticMarkup(
    React.createElement(PaymentCheckoutBridge, {
      checkoutResult: {
        success: true,
        reservation_id: RES_ID,
        payment_id: PAY_ID,
        reference_code: REF_CODE,
        provider_name: 'hitpay',
        expected_amount: 350,
        currency: '₱',
        checkout_url: 'https://securecheckout.sandbox.hit-pay.com/payment-request/@lockacourt/req_hp_status_001',
      },
      isLoading: false,
      errorMessage: null,
      isDemoFacility: false,
      onSimulateSuccess: () => {},
      onRetry: () => {},
      onCancel: () => {},
    })
  );
  assert.ok(hitpayHtml.includes('HitPay Official Checkout'));
  assert.ok(hitpayHtml.includes('Open HitPay Hosted Checkout'));
  assert.ok(!hitpayHtml.includes('PayMongo Official Checkout'));

  // Frontend demo mode still makes 0 network calls
  let netCalls = 0;
  globalThis.fetch = async () => {
    netCalls++;
    throw new Error('Must not make network calls in frontend demo mode');
  };
  try {
    const demoRes = await createBookingCheckoutSession({
      facility_id: 'demo-fac-1',
      court_id: 'demo-court-1',
      customer_name: 'Demo Player',
      booking_date: '2026-12-01',
      start_time: '2026-12-01T01:00:00Z',
      duration_minutes: 90,
      idempotency_key: 'idem_demo_isolated_check_001',
      is_frontend_demo: true,
      hourly_rate: 400,
    });
    assert.equal(netCalls, 0);
    assert.equal(demoRes.success, true);
    assert.equal(demoRes.expected_amount, 600);
    assert.equal(demoRes.isSimulated, true);

    // Client preserves provider_not_configured cleanly when Edge Function returns 503 provider_not_configured
    const prevSupaUrl = process.env.VITE_SUPABASE_URL;
    const prevSupaKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    process.env.VITE_SUPABASE_URL = 'https://test-project.supabase.co';
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'anon_test_publishable_key_for_unit_test_12345';
    globalThis.fetch = async (url, opts) => {
      const req = new Request(String(url), {
        method: opts?.method || 'POST',
        headers: opts?.headers || { 'Content-Type': 'application/json' },
        body: opts?.body,
      });
      return handleCreateCheckoutSessionRequest(req, {
        supabaseAdmin: { rpc: async () => ({ data: null, error: { message: 'must not run' } }) },
        env: {
          SUPABASE_URL: 'https://test-project.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
          ACTIVE_PAYMENT_PROVIDER: 'hitpay',
        },
      });
    };
    try {
      const clientMod = await import(`../../src/lib/supabaseClient?hitpay_unconf=${Date.now()}`);
      const clientUnconfRes = await clientMod.createBookingCheckoutSession({
        facility_id: FAC_ID,
        court_id: COURT_ID,
        customer_name: 'Live Player',
        customer_phone: '09171234567',
        booking_date: '2026-12-01',
        start_time: '2026-12-01T01:00:00Z',
        duration_minutes: 60,
        idempotency_key: 'idem_client_unconfigured_001',
        is_frontend_demo: false,
      });
      assert.equal(clientUnconfRes.success, false);
      assert.equal(clientUnconfRes.code, 'provider_not_configured');
      assert.equal(clientUnconfRes.status, 'provider_not_configured');
      assert.equal(clientUnconfRes.checkout_url, undefined);
    } finally {
      if (prevSupaUrl === undefined) delete process.env.VITE_SUPABASE_URL;
      else process.env.VITE_SUPABASE_URL = prevSupaUrl;
      if (prevSupaKey === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = prevSupaKey;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  passed++;
  console.log('✓ Suite 5: get-booking-status, PaymentCheckoutBridge & frontend demo isolation passed');
}

console.log('======================================================');
console.log(`ALL ${passed} HITPAY STAGE 2 SANDBOX SUITES PASSED!`);
console.log('======================================================');
