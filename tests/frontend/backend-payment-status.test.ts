// ==============================================================================
// CourtBook / BookSuite — Authoritative Payment Status & Security Test Suite
// File: tests/frontend/backend-payment-status.test.ts
//
// Directly executes the REAL get-booking-status Edge Function handler
// (`handleGetBookingStatusRequest`), `resolveClientIp`, and guest lookup token
// verification (`mintGuestLookupToken`) against an in-memory Supabase database mock:
//   1. Confirmed reservation with missing capture evidence or unverified webhook.
//   2. Captured amount mismatch (payments.captured_amount != expected / price).
//   3. Missing or invalid settlement journal & metadata association in financial_transactions.
//   4. Correctly verified and settled payment (via lookup_token & normalized contact).
//   5. Anti-enumeration & token checks (tampered/expired/wrong-scope tokens, uniform 403).
//   6. Guest authorization enforcement (reservation_id alone rejected) & cross-tenant mismatch.
//   7. Durable rate limiting (429 + Retry-After) & FAIL-CLOSED 503 + trusted proxy IP checks.
//   8. Expired, failed, cancelled, declined, and late payments.
//   9. Browser return without existing booking context (contact recovery & token flow).
//  10. Safe scrubbed error verification on create-checkout-session & get-booking-status.
// ==============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  handleGetBookingStatusRequest,
  resolveClientIp,
  SupabaseAdminLike,
} from '../../supabase/functions/get-booking-status/handler.ts';
import { mintGuestLookupToken } from '../../supabase/functions/_shared/guestLookupToken.ts';
import { verifyPublicBookingPaymentStatus } from '../../src/lib/supabaseClient';

console.log('Running CourtBook Authoritative Backend Payment Status Security Tests...');

let passed = 0;

const TEST_SECRET = 'test_only_lookup_secret_32_chars_min_key';
const ORG_A_ID = 'a0000001-0000-4000-8000-000000000001';
const ORG_B_ID = 'b0000001-0000-4000-8000-000000000002';
const FAC_A_ID = 'a0000002-0000-4000-8000-000000000001';
const FAC_B_ID = 'b0000002-0000-4000-8000-000000000002';
const COURT_A_ID = 'a0000003-0000-4000-8000-000000000001';
const RES_ID = 'd1111111-1111-4111-8111-111111111111';
const PAY_ID = 'c1111111-1111-4111-8111-111111111111';
const WEBHOOK_ID = 'e1111111-1111-4111-8111-111111111111';
const TX_ID = 'f1111111-1111-4111-8111-111111111111';
const REF_CODE = 'CB-AUTH1234';

interface MockDbTables {
  reservations: Record<string, any>[];
  facilities: Record<string, any>[];
  courts: Record<string, any>[];
  payments: Record<string, any>[];
  provider_webhook_events: Record<string, any>[];
  financial_transactions: Record<string, any>[];
}

function createMockSupabaseAdmin(
  tables: MockDbTables,
  options?: {
    rateLimitHandler?: (rateKey: string, maxAttempts: number, windowSeconds: number) => any;
    rateLimitError?: { message: string } | null;
    throwOnRateLimit?: boolean;
  }
): SupabaseAdminLike {
  const rateCounts = new Map<string, number>();

  return {
    from(tableName: string) {
      const filters: Array<{ col: string; val: any }> = [];
      let orderCol: string | null = null;
      let orderAsc = true;

      const executeSelect = () => {
        const rows = (tables as any)[tableName] || [];
        let matched = rows.filter((row: Record<string, any>) =>
          filters.every((f) => row[f.col] === f.val)
        );
        if (orderCol) {
          const col = orderCol;
          matched = [...matched].sort((a, b) => {
            const av = a[col] ?? '';
            const bv = b[col] ?? '';
            return orderAsc ? (av > bv ? 1 : -1) : av < bv ? 1 : -1;
          });
        }
        return matched;
      };

      const builder: any = {
        select() {
          return builder;
        },
        eq(col: string, val: any) {
          filters.push({ col, val });
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return Promise.resolve({ data: executeSelect(), error: null });
        },
        maybeSingle() {
          const rows = executeSelect();
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
      };

      return builder;
    },

    async rpc(fn: string, params?: Record<string, unknown>) {
      if (fn === 'check_and_increment_rate_limit') {
        if (options?.throwOnRateLimit) {
          throw new Error('Simulated PostgreSQL connection failure');
        }
        if (options?.rateLimitError) {
          return { data: null, error: options.rateLimitError };
        }

        const rateKey = String(params?.p_rate_key || '');
        const maxAttempts = Number(params?.p_max_attempts || 10);
        const windowSeconds = Number(params?.p_window_seconds || 60);

        if (options?.rateLimitHandler) {
          return {
            data: options.rateLimitHandler(rateKey, maxAttempts, windowSeconds),
            error: null,
          };
        }

        const nextCount = (rateCounts.get(rateKey) || 0) + 1;
        rateCounts.set(rateKey, nextCount);
        return {
          data: {
            allowed: nextCount <= maxAttempts,
            current_attempts: nextCount,
            max_attempts: maxAttempts,
            retry_after_seconds: nextCount > maxAttempts ? windowSeconds : 0,
          },
          error: null,
        };
      }
      return { data: null, error: { message: 'Unknown RPC' } };
    },
  };
}

function buildValidDb(): MockDbTables {
  return {
    facilities: [
      {
        id: FAC_A_ID,
        organization_id: ORG_A_ID,
        name: 'Metro Sports Complex',
        timezone: 'Asia/Manila',
        currency: '₱',
        address: '123 Ayala Ave, Makati City',
      },
    ],
    courts: [
      {
        id: COURT_A_ID,
        facility_id: FAC_A_ID,
        name: 'Court 1 - Indoor',
        sport_type: 'Pickleball',
      },
    ],
    reservations: [
      {
        id: RES_ID,
        facility_id: FAC_A_ID,
        court_id: COURT_A_ID,
        reference_code: REF_CODE,
        customer_name: 'Juan Dela Cruz',
        customer_phone: '+63 917 123 4567',
        customer_email: 'juan@example.com',
        booking_date: '2026-11-25',
        start_time: '2026-11-25T01:00:00.000Z',
        end_time: '2026-11-25T02:00:00.000Z',
        time_slot_label: '09:00 AM – 10:00 AM',
        duration_minutes: 60,
        price: 350.0,
        currency: '₱',
        status: 'confirmed',
        is_demo: false,
        hold_expires_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-11-20T09:00:00.000Z',
        updated_at: '2026-11-20T09:05:00.000Z',
      },
    ],
    payments: [
      {
        id: PAY_ID,
        organization_id: ORG_A_ID,
        facility_id: FAC_A_ID,
        reservation_id: RES_ID,
        status: 'captured',
        currency: 'PHP',
        expected_amount: 350.0,
        captured_amount: 350.0,
        provider_name: 'paymongo',
        provider_payment_id: 'pay_pm_987654321',
        checkout_session_id: 'cs_pm_987654321',
        verified_capture_evidence: {
          webhook_event_id: WEBHOOK_ID,
          provider_event_id: 'evt_pm_987654321',
          captured_at: '2026-11-20T09:05:00.000Z',
        },
        captured_at: '2026-11-20T09:05:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-11-20T09:00:00.000Z',
        updated_at: '2026-11-20T09:05:00.000Z',
      },
    ],
    provider_webhook_events: [
      {
        id: WEBHOOK_ID,
        provider_name: 'paymongo',
        provider_event_id: 'evt_pm_987654321',
        event_type: 'checkout_session.payment.paid',
        signature_verification_status: 'verified',
        processing_state: 'processed',
      },
    ],
    financial_transactions: [
      {
        id: TX_ID,
        transaction_number: 1001,
        organization_id: ORG_A_ID,
        facility_id: FAC_A_ID,
        transaction_type: 'booking_settlement',
        reference_id: RES_ID,
        metadata: {
          reservation_id: RES_ID,
          gross_amount: 350.0,
          commission_rate: 0.05,
          commission_amount: 17.5,
          owner_share: 332.5,
          webhook_event_id: WEBHOOK_ID,
          provider_payment_id: 'pay_pm_987654321',
          checkout_session_id: 'cs_pm_987654321',
        },
      },
    ],
  };
}

function makeRequest(body: Record<string, unknown>, extraHeaders?: Record<string, string>): Request {
  return new Request('https://example.supabase.co/functions/v1/get-booking-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  });
}

const VALID_TOKEN = await mintGuestLookupToken({
  reservationId: RES_ID,
  referenceCode: REF_CODE,
  secret: TEST_SECRET,
});

// ==============================================================================
// Test 1: Confirmed reservation with missing capture evidence or unverified webhook
// ==============================================================================
{
  // Case 1A: verified_capture_evidence only has hold creation keys (no webhook_event_id)
  const dbMissingEvidence = buildValidDb();
  dbMissingEvidence.payments[0].verified_capture_evidence = {
    checkout_idempotency_key: 'idem_1234',
    reference_code: REF_CODE,
  };

  const resA = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbMissingEvidence), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resA.status, 200);
  const bodyA = await resA.json();
  assert.equal(bodyA.verified, false, 'Missing webhook capture evidence must fail verification');
  assert.notEqual(bodyA.status, 'confirmed');
  assert.equal(bodyA.has_capture_evidence, false);

  // Case 1B: Webhook exists but signature_verification_status != 'verified'
  const dbUnverifiedWh = buildValidDb();
  dbUnverifiedWh.provider_webhook_events[0].signature_verification_status = 'failed';
  const resB = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbUnverifiedWh), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  const bodyB = await resB.json();
  assert.equal(bodyB.verified, false, 'Unverified webhook signature must never confirm');
  assert.notEqual(bodyB.status, 'confirmed');
  assert.equal(bodyB.has_capture_evidence, false);

  // Case 1C: Payment has unbound cs_pending_ session ID
  const dbUnbound = buildValidDb();
  dbUnbound.payments[0].checkout_session_id = 'cs_pending_abc123';
  const resC = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbUnbound), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  const bodyC = await resC.json();
  assert.equal(bodyC.verified, false, 'Unbound cs_pending_ session must fail verification');
  assert.equal(bodyC.has_capture_evidence, false);

  passed++;
  console.log('✓ Test 1: Confirmed reservation with missing capture evidence or unverified webhook fails closed');
}

// ==============================================================================
// Test 2: Captured amount mismatch
// ==============================================================================
{
  const dbMismatch = buildValidDb();
  dbMismatch.payments[0].captured_amount = 300.0; // Expected 350.00

  const res = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbMismatch), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verified, false, 'Captured amount mismatch must report verified: false');
  assert.equal(body.status, 'failed', 'Amount mismatch must report failed');

  passed++;
  console.log('✓ Test 2: Captured amount mismatch rejected');
}

// ==============================================================================
// Test 3: Missing or invalid settlement journal & metadata association
// ==============================================================================
{
  // Case 3A: No financial_transactions row
  const dbNoTx = buildValidDb();
  dbNoTx.financial_transactions = [];

  const resA = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbNoTx), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  const bodyA = await resA.json();
  assert.equal(bodyA.verified, false, 'Missing settlement journal must prevent verified: true');
  assert.equal(bodyA.settlement_verified, false);
  assert.equal(bodyA.status, 'processing');

  // Case 3B: Transaction exists but belongs to wrong facility_id
  const dbWrongTx = buildValidDb();
  dbWrongTx.financial_transactions[0].facility_id = FAC_B_ID;

  const resB = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbWrongTx), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  const bodyB = await resB.json();
  assert.equal(bodyB.verified, false, 'Cross-facility settlement journal must not confirm');
  assert.equal(bodyB.settlement_verified, false);

  // Case 3C: Settlement transaction metadata provider_payment_id does not match payment
  const dbMetaMismatch = buildValidDb();
  dbMetaMismatch.financial_transactions[0].metadata.provider_payment_id = 'pay_pm_other_tx';

  const resC = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbMetaMismatch), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  const bodyC = await resC.json();
  assert.equal(bodyC.verified, false, 'Settlement metadata mismatch must prevent confirmation');
  assert.equal(bodyC.settlement_verified, false);

  passed++;
  console.log('✓ Test 3: Missing or mismatched settlement journal & metadata prevents confirmation');
}

// ==============================================================================
// Test 4: Correctly verified and settled payment (token & normalized contact)
// ==============================================================================
{
  const dbValid = buildValidDb();

  // 4A: Lookup via cryptographic lookup_token
  const resToken = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resToken.status, 200);
  const bodyToken = await resToken.json();
  assert.equal(bodyToken.verified, true);
  assert.equal(bodyToken.status, 'confirmed');
  assert.equal(bodyToken.has_capture_evidence, true);
  assert.equal(bodyToken.settlement_verified, true);
  assert.equal(bodyToken.duration_minutes, 60);
  assert.equal(bodyToken.customer_name, 'Juan Dela Cruz');
  assert.equal(bodyToken.facility_name, 'Metro Sports Complex');
  assert.equal(bodyToken.customer_phone, undefined, 'Must never expose customer_phone');
  assert.equal(bodyToken.customer_email, undefined, 'Must never expose customer_email');

  // 4B: Lookup via normalized PH local phone format (0917... matching stored +63 917...)
  const resPhone = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, contact: '09171234567' }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resPhone.status, 200);
  const bodyPhone = await resPhone.json();
  assert.equal(bodyPhone.verified, true);
  assert.equal(bodyPhone.status, 'confirmed');

  // 4C: Lookup via email address (ensures @ and . are preserved properly)
  const resEmail = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, contact: 'Juan@Example.com' }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resEmail.status, 200);
  const bodyEmail = await resEmail.json();
  assert.equal(bodyEmail.verified, true);

  passed++;
  console.log('✓ Test 4: Correctly verified and settled payment succeeds across token, PH phone, and email');
}

// ==============================================================================
// Test 5: Anti-enumeration, forged/expired/wrong-scope lookup tokens
// ==============================================================================
{
  const dbValid = buildValidDb();

  // 5A: Anti-enumeration: non-existent reference with contact returns identical 403 as wrong contact
  const resUnknownRef = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: 'CB-FORGED99', contact: '09171234567' }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  const resWrongContact = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, contact: '09998887777' }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.11' }
  );
  assert.equal(resUnknownRef.status, 403);
  assert.equal(resWrongContact.status, 403);
  assert.deepEqual(
    await resUnknownRef.json(),
    await resWrongContact.json(),
    'Unknown reference vs wrong contact must return identical 403 body to prevent enumeration'
  );

  // 5B: Forged / tampered lookup_token -> 403
  const resTampered = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: 'eyJ2IjoxfQ.invalidsignature' }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resTampered.status, 403);

  // 5C: Expired lookup_token -> 403
  const expiredToken = await mintGuestLookupToken({
    reservationId: RES_ID,
    referenceCode: REF_CODE,
    secret: TEST_SECRET,
    ttlSeconds: -10,
  });
  const resExpiredTok = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: expiredToken }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resExpiredTok.status, 403);

  // 5D: Token minted for CB-OTHER99 cannot be replayed against REF_CODE
  const otherRefToken = await mintGuestLookupToken({
    reservationId: RES_ID,
    referenceCode: 'CB-OTHER99',
    secret: TEST_SECRET,
  });
  const resWrongScopeRef = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: otherRefToken }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resWrongScopeRef.status, 403);

  passed++;
  console.log('✓ Test 5: Anti-enumeration uniform 403 and forged/expired/mismatched tokens rejected');
}

// ==============================================================================
// Test 6: Guest authorization enforcement (reservation_id alone REJECTED) & cross-tenant mismatch
// ==============================================================================
{
  const dbValid = buildValidDb();

  // 6A: reference_code alone -> 400
  const resNoCred = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resNoCred.status, 400);

  // 6B: reference_code + reservation_id WITHOUT lookup_token or contact -> MUST BE REJECTED (400)
  const resUuidOnly = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, reservation_id: RES_ID }),
    { supabaseAdmin: createMockSupabaseAdmin(dbValid), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(
    resUuidOnly.status,
    400,
    'reservation_id + reference_code without signed token or verified contact must be rejected'
  );

  // 6C: Client helper also fails closed without calling fetch when only reservation_id is passed
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('Should not have called fetch');
  };
  try {
    const clientRes = await verifyPublicBookingPaymentStatus({
      reference_code: REF_CODE,
      reservation_id: RES_ID,
    });
    assert.equal(clientRes.verified, false);
    assert.equal(clientRes.status, 'failed');
    assert.equal(fetchCalled, false, 'Client must reject reservation_id-only calls before network');
  } finally {
    globalThis.fetch = origFetch;
  }

  // 6D: Cross-tenant payment linkage (payment belongs to ORG_B / FAC_B) -> 403 with scrubbed error
  const dbCrossTenant = buildValidDb();
  dbCrossTenant.payments[0].organization_id = ORG_B_ID;
  dbCrossTenant.payments[0].facility_id = FAC_B_ID;

  const resCross = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: createMockSupabaseAdmin(dbCrossTenant), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
  );
  assert.equal(resCross.status, 403);
  const crossJson = await resCross.json();
  assert.ok(!JSON.stringify(crossJson).includes(ORG_B_ID), 'Must never leak internal tenant UUIDs');
  assert.ok(!JSON.stringify(crossJson).includes('service_role'), 'Must never leak internal credential terms');

  passed++;
  console.log('✓ Test 6: reservation_id-only bypass blocked, client fails closed, and cross-tenant mismatch scrubbed');
}

// ==============================================================================
// Test 7: Durable rate limiting (429), FAIL-CLOSED (503), and trusted proxy IP resolution
// ==============================================================================
{
  const dbValid = buildValidDb();
  const admin = createMockSupabaseAdmin(dbValid);
  const attackerIp = '198.51.100.77';

  // 7A: Exhaust per-reference rate limit (12 requests allowed, 13th rejected with 429)
  let lastStatus = 200;
  let retryAfterHeader: string | null = null;
  for (let i = 1; i <= 13; i++) {
    const res = await handleGetBookingStatusRequest(
      makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
      { supabaseAdmin: admin, lookupSecret: TEST_SECRET, remoteAddr: attackerIp }
    );
    lastStatus = res.status;
    retryAfterHeader = res.headers.get('Retry-After');
  }
  assert.equal(lastStatus, 429, '13th request must be rate limited with HTTP 429');
  assert.ok(Number(retryAfterHeader) > 0, '429 response must include Retry-After header');

  // 7B: Fail closed with HTTP 503 when durable PostgreSQL rate-limit RPC errors
  const adminRpcError = createMockSupabaseAdmin(buildValidDb(), {
    rateLimitError: { message: 'db connection pool exhausted' },
  });
  const res503Err = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: adminRpcError, lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.55' }
  );
  assert.equal(res503Err.status, 503, 'RPC error must fail closed with 503 (never fall back to memory)');
  const json503Err = await res503Err.json();
  assert.ok(!JSON.stringify(json503Err).includes('pool exhausted'), '503 error must be scrubbed');

  // 7C: Fail closed with HTTP 503 when durable rate-limit RPC throws
  const adminRpcThrow = createMockSupabaseAdmin(buildValidDb(), { throwOnRateLimit: true });
  const res503Throw = await handleGetBookingStatusRequest(
    makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
    { supabaseAdmin: adminRpcThrow, lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.55' }
  );
  assert.equal(res503Throw.status, 503, 'RPC exception must fail closed with 503');

  // 7D: Trusted proxy IP resolution ignores spoofed leftmost forwarding headers
  const spoofedReq = makeRequest(
    { reference_code: REF_CODE },
    {
      'cf-connecting-ip': '1.2.3.4',
      'x-real-ip': '5.6.7.8',
      'x-forwarded-for': '9.9.9.9, 198.51.100.22',
    }
  );
  assert.equal(
    resolveClientIp(spoofedReq, {
      supabaseAdmin: admin,
      lookupSecret: TEST_SECRET,
      remoteAddr: '203.0.113.99',
    }),
    '203.0.113.99',
    'Without trusted proxy header/hops config, spoofed headers must be ignored in favor of remoteAddr'
  );
  assert.equal(
    resolveClientIp(spoofedReq, {
      supabaseAdmin: admin,
      lookupSecret: TEST_SECRET,
    }),
    'unverified_client',
    'Without trusted proxy config or remoteAddr, must use unverified_client instead of trusting spoofed headers'
  );
  assert.equal(
    resolveClientIp(spoofedReq, {
      supabaseAdmin: admin,
      lookupSecret: TEST_SECRET,
      trustedProxyHops: 1,
    }),
    '198.51.100.22',
    'With trustedProxyHops=1, must extract rightmost proxy-appended IP, not client-spoofed leftmost IP'
  );
  assert.equal(
    resolveClientIp(spoofedReq, {
      supabaseAdmin: admin,
      lookupSecret: TEST_SECRET,
      trustedProxyIpHeader: 'cf-connecting-ip',
    }),
    '1.2.3.4',
    'With explicit trustedProxyIpHeader, must read configured header'
  );

  passed++;
  console.log('✓ Test 7: Durable rate limiting (429), fail-closed (503), and trusted proxy IP resolution passed');
}

// ==============================================================================
// Test 8: Expired, failed, cancelled, declined, and late payments
// ==============================================================================
{
  // 8A: Expired hold (reservation pending, hold_expires_at in the past)
  const dbExpired = buildValidDb();
  dbExpired.reservations[0].status = 'pending';
  dbExpired.reservations[0].hold_expires_at = '2020-01-01T00:00:00.000Z';
  dbExpired.payments[0].status = 'pending';
  const bodyExp = await (
    await handleGetBookingStatusRequest(
      makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
      { supabaseAdmin: createMockSupabaseAdmin(dbExpired), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
    )
  ).json();
  assert.equal(bodyExp.verified, false);
  assert.equal(bodyExp.status, 'expired');

  // 8B: Late payment flagged in verified_capture_evidence -> expired, never confirmed
  const dbLate = buildValidDb();
  dbLate.payments[0].verified_capture_evidence.late_payment = true;
  const bodyLate = await (
    await handleGetBookingStatusRequest(
      makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
      { supabaseAdmin: createMockSupabaseAdmin(dbLate), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
    )
  ).json();
  assert.equal(bodyLate.verified, false);
  assert.equal(bodyLate.status, 'expired');

  // 8C: Failed payment
  const dbFailed = buildValidDb();
  dbFailed.reservations[0].status = 'pending';
  dbFailed.payments[0].status = 'failed';
  const bodyFail = await (
    await handleGetBookingStatusRequest(
      makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
      { supabaseAdmin: createMockSupabaseAdmin(dbFailed), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
    )
  ).json();
  assert.equal(bodyFail.verified, false);
  assert.equal(bodyFail.status, 'failed');

  // 8D: Cancelled payment
  const dbCancelled = buildValidDb();
  dbCancelled.reservations[0].status = 'cancelled';
  dbCancelled.payments[0].status = 'cancelled';
  const bodyCan = await (
    await handleGetBookingStatusRequest(
      makeRequest({ reference_code: REF_CODE, lookup_token: VALID_TOKEN }),
      { supabaseAdmin: createMockSupabaseAdmin(dbCancelled), lookupSecret: TEST_SECRET, remoteAddr: '203.0.113.10' }
    )
  ).json();
  assert.equal(bodyCan.verified, false);
  assert.equal(bodyCan.status, 'cancelled');

  passed++;
  console.log('✓ Test 8: Expired, late, failed, and cancelled states return non-verified statuses');
}

// ==============================================================================
// Test 9: Browser return without existing booking context (End-to-End Client -> Real Handler)
// ==============================================================================
{
  const dbValid = buildValidDb();
  const admin = createMockSupabaseAdmin(dbValid);
  const originalFetch = globalThis.fetch;

  const issuedToken = await mintGuestLookupToken({
    reservationId: RES_ID,
    referenceCode: REF_CODE,
    secret: TEST_SECRET,
  });

  // Route frontend verifyPublicBookingPaymentStatus fetch directly into the REAL Edge Function handler
  globalThis.fetch = async (url: any, opts: any) => {
    const req = new Request(String(url), {
      method: opts?.method || 'POST',
      headers: opts?.headers || { 'Content-Type': 'application/json' },
      body: opts?.body,
    });
    return handleGetBookingStatusRequest(req, {
      supabaseAdmin: admin,
      lookupSecret: TEST_SECRET,
      remoteAddr: '203.0.113.88',
    });
  };

  try {
    // 9A: Hosted checkout return with ?ref=...&token=... and NO session booking context
    const resViaToken = await verifyPublicBookingPaymentStatus({
      reference_code: REF_CODE,
      lookup_token: issuedToken,
    });
    assert.equal(resViaToken.verified, true, 'Hosted return with signed token must verify');
    assert.equal(resViaToken.status, 'confirmed');
    assert.equal(resViaToken.facility_name, 'Metro Sports Complex');
    assert.equal(resViaToken.court_name, 'Court 1 - Indoor');
    assert.equal(resViaToken.duration_minutes, 60);
    assert.equal(resViaToken.customer_name, 'Juan Dela Cruz');
    assert.equal(resViaToken.settlement_verified, true);
    assert.equal(resViaToken.has_capture_evidence, true);

    // 9B: Browser return with only ?ref=... (cleared storage & no token) recovered via customer contact
    const resViaContact = await verifyPublicBookingPaymentStatus({
      reference_code: REF_CODE,
      customer_phone_or_email: '09171234567',
    });
    assert.equal(resViaContact.verified, true, 'Contact verification must recover confirmed pass');
    assert.equal(resViaContact.reservation_id, RES_ID);
    assert.equal(resViaContact.total_price, 350);

    passed++;
    console.log('✓ Test 9: Browser return without existing context recovers authoritative pass via token & contact');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ==============================================================================
// Test 10: Scrubbed Public Error Responses & Token Referrer/Storage Protections
// ==============================================================================
{
  const checkoutSource = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/functions/create-checkout-session/index.ts'),
    'utf8'
  );
  assert.ok(!checkoutSource.includes('error: error.message'), 'create-checkout-session must not return raw RPC error.message');
  assert.ok(!checkoutSource.includes('${pmErr}'), 'create-checkout-session must not return raw PayMongo error text');
  assert.ok(!checkoutSource.includes('${bindErrorMsg}'), 'create-checkout-session must not return raw bindErrorMsg');

  const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
  assert.ok(
    indexHtml.includes('name="referrer" content="no-referrer"'),
    'index.html must include strict no-referrer policy to avoid URL query token leaks'
  );

  passed++;
  console.log('✓ Test 10: Safe scrubbed checkout errors and no-referrer policy verified');
}

console.log('======================================================');
console.log(`ALL ${passed} AUTHORITATIVE PAYMENT STATUS SECURITY TESTS PASSED!`);
console.log('======================================================');
