// ==============================================================================
// CourtBook / BookSuite — Webhook Signature & Adapter Unit Tests
// File: tests/supabase/suites/webhook-signature.test.ts
// ==============================================================================

import crypto from 'node:crypto';
import { PayMongoAdapter } from '../../../src/lib/payments/paymongo-adapter';
import { PaymentProviderRegistry, XenditAdapter } from '../../../src/lib/payments/provider-adapter';

export function runWebhookSignatureTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, errorDetail?: string) {
    if (condition) {
      passed++;
    } else {
      failed++;
      errors.push(`FAILED: ${testName} ${errorDetail || ''}`);
    }
  }

  const adapter = new PayMongoAdapter();
  const testSecret = 'whsec_test_secret_key_12345';
  const rawBody = JSON.stringify({
    data: {
      id: 'evt_test_001',
      attributes: {
        type: 'payment.paid',
        created_at: Math.floor(Date.now() / 1000),
        data: {
          id: 'pay_test_001',
          attributes: {
            amount: 35000,
            currency: 'PHP',
            metadata: { checkout_session_id: 'cs_test_session_123' }
          }
        }
      }
    }
  });

  // Test 1: Valid live signature
  {
    const ts = Math.floor(Date.now() / 1000);
    const expectedPayload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', testSecret).update(expectedPayload).digest('hex');
    const header = `t=${ts},li=${hmac}`;

    const res = adapter.verifyWebhookSignature(rawBody, header, testSecret, 300);
    assert(res.isValid === true && res.mode === 'live', 'Test 1: Valid live mode signature verified');
  }

  // Test 2: Valid test signature
  {
    const ts = Math.floor(Date.now() / 1000);
    const expectedPayload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', testSecret).update(expectedPayload).digest('hex');
    const header = `t=${ts},te=${hmac}`;

    const res = adapter.verifyWebhookSignature(rawBody, header, testSecret, 300);
    assert(res.isValid === true && res.mode === 'test', 'Test 2: Valid test mode signature verified');
  }

  // Test 3: Forged / tampered signature rejected
  {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},te=badc0ffeebadc0ffeebadc0ffee1234567890abcdef1234567890abcdef123456`;

    const res = adapter.verifyWebhookSignature(rawBody, header, testSecret, 300);
    assert(res.isValid === false, 'Test 3: Forged signature strictly rejected');
  }

  // Test 4: Tampered body payload with authentic signature header rejected
  {
    const ts = Math.floor(Date.now() / 1000);
    const expectedPayload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', testSecret).update(expectedPayload).digest('hex');
    const header = `t=${ts},li=${hmac}`;

    const tamperedBody = rawBody.replace('35000', '10000');
    const res = adapter.verifyWebhookSignature(tamperedBody, header, testSecret, 300);
    assert(res.isValid === false, 'Test 4: Tampered body rejected despite authentic header');
  }

  // Test 5: Expired timestamp tolerance (> 300s) rejected
  {
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const expectedPayload = `${staleTs}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', testSecret).update(expectedPayload).digest('hex');
    const header = `t=${staleTs},li=${hmac}`;

    const res = adapter.verifyWebhookSignature(rawBody, header, testSecret, 300);
    assert(res.isValid === false && (res.error?.includes('tolerance') ?? false), 'Test 5: Stale timestamp rejected');
  }

  // Test 6: Normalization maps centavos to PHP correctly
  {
    const parsed = JSON.parse(rawBody);
    const normalized = adapter.normalizeWebhook(parsed);
    assert(
      normalized.providerName === 'paymongo' &&
      normalized.capturedAmount === 350.00 &&
      normalized.checkoutSessionId === 'cs_test_session_123' &&
      normalized.status === 'paid',
      'Test 6: Normalization accurately parsed centavos 35000 to PHP 350.00'
    );
  }

  // Test 7: Xendit adapter is marked NOT READY
  {
    const xendit = PaymentProviderRegistry.getAdapter('xendit');
    const res = xendit.verifyWebhookSignature('', '', '');
    assert(
      xendit.isReady === false && res.isValid === false && (res.error?.includes('NOT READY') ?? false),
      'Test 7: Xendit adapter safely isolated behind interface and marked NOT READY'
    );
  }

  return { passed, failed, errors };
}
