// ==============================================================================
// LockaCourt (AratReserve) — Offline HitPay Sandbox Test Fixtures & Mock API
// File: tests/payments/hitpay-fixtures.ts
//
// Provides deterministic mocked HitPay API responses and HMAC-SHA256 signed
// webhook fixtures for offline testing without live HitPay credentials.
// ==============================================================================

import crypto from 'node:crypto';

export const OFFLINE_HITPAY_TEST_API_KEY = 'hp_offline_fixture_api_key_do_not_use_in_prod';
export const OFFLINE_HITPAY_TEST_SALT = 'hp_offline_fixture_webhook_salt_do_not_use_in_prod';

export function signOfflineHitPayWebhookBody(
  rawBody: string,
  salt: string = OFFLINE_HITPAY_TEST_SALT
): string {
  return crypto.createHmac('sha256', salt).update(rawBody, 'utf8').digest('hex').toLowerCase();
}

export function buildMockHitPayPaymentRequestResponse(overrides?: {
  id?: string;
  status?: 'pending' | 'completed' | 'failed' | 'expired';
  amount?: string;
  currency?: string;
  reference_number?: string;
  url?: string;
}) {
  const id = overrides?.id || 'req_hp_sandbox_fixture_001';
  return {
    id,
    url:
      overrides?.url ||
      `https://securecheckout.sandbox.hit-pay.com/payment-request/@lockacourt/${id}`,
    status: overrides?.status || 'pending',
    amount: overrides?.amount || '350.00',
    currency: overrides?.currency || 'PHP',
    reference_number: overrides?.reference_number || 'CB-HP-FIXTURE1',
    created_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
  };
}

export function buildSignedHitPayWebhookFixture(options: {
  id: string;
  paymentId: string;
  paymentRequestId?: string;
  status: 'completed' | 'refunded' | 'partially_refunded' | 'failed';
  amount: string;
  currency?: string;
  referenceNumber?: string;
  eventId?: string;
  eventTypeHeader?: string;
  eventObjectHeader?: string;
  url?: string;
  salt?: string;
}) {
  const payload: Record<string, unknown> = {
    id: options.id,
    payment_id: options.paymentId,
    payment_request_id: options.paymentRequestId || options.id,
    status: options.status,
    amount: options.amount,
    currency: options.currency || 'PHP',
  };
  if (options.referenceNumber) payload.reference_number = options.referenceNumber;
  if (options.eventId) payload.event_id = options.eventId;
  if (options.url) payload.url = options.url;

  const rawBody = JSON.stringify(payload);
  const signature = signOfflineHitPayWebhookBody(rawBody, options.salt || OFFLINE_HITPAY_TEST_SALT);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Hitpay-Signature': signature,
  };
  if (options.eventTypeHeader) headers['Hitpay-Event-Type'] = options.eventTypeHeader;
  if (options.eventObjectHeader) headers['Hitpay-Event-Object'] = options.eventObjectHeader;

  return { payload, rawBody, signature, headers };
}

export function buildMockHitPayRefundResponse(overrides?: {
  id?: string;
  payment_id?: string;
  status?: 'succeeded' | 'completed' | 'refunded' | 'pending' | 'failed';
  amount_refunded?: string;
  currency?: string;
}) {
  const id = overrides?.id || 'ref_hp_sandbox_fixture_001';
  return {
    id,
    payment_id: overrides?.payment_id || 'chg_hp_12500',
    status: overrides?.status || 'succeeded',
    amount_refunded: overrides?.amount_refunded || '4000.00',
    currency: overrides?.currency || 'PHP',
    created_at: '2026-11-18T10:05:00Z',
    updated_at: '2026-11-18T10:05:00Z',
  };
}

export function buildSignedHitPayRefundWebhookFixture(options: {
  id: string;
  paymentId: string;
  paymentRequestId?: string;
  refundId?: string;
  status: 'refunded' | 'partially_refunded';
  amount?: string;
  amountRefunded?: string;
  refundedAmount?: string;
  refundAmount?: string;
  currency?: string;
  eventId?: string;
  eventTypeHeader?: string;
  eventObjectHeader?: string;
  salt?: string;
}) {
  const payload: Record<string, unknown> = {
    id: options.id,
    payment_id: options.paymentId,
    status: options.status,
    currency: options.currency || 'PHP',
  };
  if (options.paymentRequestId) payload.payment_request_id = options.paymentRequestId;
  if (options.refundId) payload.refund_id = options.refundId;
  if (options.amount !== undefined) payload.amount = options.amount;
  if (options.amountRefunded !== undefined) payload.amount_refunded = options.amountRefunded;
  if (options.refundedAmount !== undefined) payload.refunded_amount = options.refundedAmount;
  if (options.refundAmount !== undefined) payload.refund_amount = options.refundAmount;
  if (options.eventId) payload.event_id = options.eventId;

  const rawBody = JSON.stringify(payload);
  const signature = signOfflineHitPayWebhookBody(rawBody, options.salt || OFFLINE_HITPAY_TEST_SALT);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Hitpay-Signature': signature,
    'Hitpay-Event-Type': options.eventTypeHeader || 'updated',
    'Hitpay-Event-Object': options.eventObjectHeader || 'charge',
  };

  return { payload, rawBody, signature, headers };
}

