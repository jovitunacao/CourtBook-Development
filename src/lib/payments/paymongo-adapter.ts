// ==============================================================================
// CourtBook / BookSuite — PayMongo Provider Adapter
// File: src/lib/payments/paymongo-adapter.ts
// ==============================================================================

import crypto from 'node:crypto';
import type {
  PaymentProviderAdapter,
  WebhookVerificationResult,
  NormalizedWebhookEvent
} from './types';

export class PayMongoAdapter implements PaymentProviderAdapter {
  readonly providerName = 'paymongo';
  readonly isReady = true;

  /**
   * Verifies PayMongo webhook signatures according to official PayMongo specification.
   * Header format: "t=<timestamp>,te=<test_signature>,li=<live_signature>"
   * The signature payload to hash is: `${timestamp}.${rawBody}` using HMAC-SHA256 with the webhook signing secret.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    webhookSecret: string,
    toleranceSeconds = 300
  ): WebhookVerificationResult {
    if (!signatureHeader || !rawBody || !webhookSecret) {
      return { isValid: false, error: 'Missing rawBody, signatureHeader, or webhookSecret.' };
    }

    // Parse header elements
    const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, item) => {
      const [key, value] = item.trim().split('=');
      if (key && value) {
        acc[key.trim()] = value.trim();
      }
      return acc;
    }, {});

    const timestampStr = parts['t'];
    if (!timestampStr) {
      return { isValid: false, error: 'Missing timestamp "t" in PayMongo-Signature header.' };
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return { isValid: false, error: 'Invalid non-integer timestamp in PayMongo-Signature header.' };
    }

    // Check timestamp tolerance to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (toleranceSeconds > 0 && Math.abs(now - timestamp) > toleranceSeconds) {
      return {
        isValid: false,
        timestamp,
        error: `Timestamp tolerance exceeded. Event timestamp: ${timestamp}, server time: ${now}, tolerance: ${toleranceSeconds}s.`
      };
    }

    const expectedPayload = `${timestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(expectedPayload);
    const computedSignature = hmac.digest('hex');

    const testSig = parts['te'];
    const liveSig = parts['li'];

    if (!testSig && !liveSig) {
      return { isValid: false, error: 'Neither test ("te") nor live ("li") signature found in header.' };
    }

    let isMatch = false;
    let mode: 'test' | 'live' = 'test';

    const computedBuffer = Buffer.from(computedSignature, 'utf8');

    if (liveSig) {
      const liveBuffer = Buffer.from(liveSig, 'utf8');
      if (computedBuffer.length === liveBuffer.length && crypto.timingSafeEqual(computedBuffer, liveBuffer)) {
        isMatch = true;
        mode = 'live';
      }
    }

    if (!isMatch && testSig) {
      const testBuffer = Buffer.from(testSig, 'utf8');
      if (computedBuffer.length === testBuffer.length && crypto.timingSafeEqual(computedBuffer, testBuffer)) {
        isMatch = true;
        mode = 'test';
      }
    }

    if (!isMatch) {
      return { isValid: false, timestamp, error: 'Computed HMAC-SHA256 signature does not match header signatures.' };
    }

    return {
      isValid: true,
      timestamp,
      mode
    };
  }

  /**
   * Normalizes PayMongo webhook JSON payload into canonical CourtBook financial event.
   */
  normalizeWebhook(payload: Record<string, unknown>): NormalizedWebhookEvent {
    const data = (payload.data as Record<string, unknown>) || {};
    const attributes = (data.attributes as Record<string, unknown>) || {};
    const eventType = String(attributes.type || '');
    const eventId = String(data.id || '');
    const createdAt = typeof attributes.created_at === 'number'
      ? new Date(attributes.created_at * 1000).toISOString()
      : new Date().toISOString();

    const eventData = (attributes.data as Record<string, unknown>) || {};
    const eventDataAttrs = (eventData.attributes as Record<string, unknown>) || {};

    let providerPaymentId: string | undefined;
    let checkoutSessionId: string | undefined;
    let capturedAmount: number | undefined;
    let currency: string | undefined;
    let status: 'paid' | 'failed' | 'refunded' | 'unknown' = 'unknown';

    if (eventType === 'payment.paid' || eventType === 'checkout_session.payment.paid') {
      status = 'paid';
      providerPaymentId = String(eventData.id || data.id || '');
      
      // PayMongo amounts are represented in cents/centavos (e.g. 35000 = ₱350.00)
      const rawAmount = typeof eventDataAttrs.amount === 'number'
        ? eventDataAttrs.amount
        : (typeof attributes.amount === 'number' ? attributes.amount : 0);
      capturedAmount = rawAmount > 0 ? rawAmount / 100 : undefined;
      currency = String(eventDataAttrs.currency || attributes.currency || 'PHP');

      const metadata = (eventDataAttrs.metadata as Record<string, unknown>) || {};
      checkoutSessionId = String(
        metadata.checkout_session_id ||
        metadata.session_id ||
        eventDataAttrs.checkout_session_id ||
        ''
      ) || undefined;
    } else if (eventType === 'payment.failed') {
      status = 'failed';
      providerPaymentId = String(eventData.id || data.id || '');
    } else if (eventType === 'payment.refunded') {
      status = 'refunded';
      providerPaymentId = String(eventData.id || data.id || '');
      const rawAmount = typeof eventDataAttrs.amount === 'number' ? eventDataAttrs.amount : 0;
      capturedAmount = rawAmount > 0 ? rawAmount / 100 : undefined;
    }

    return {
      providerName: 'paymongo',
      providerEventId: eventId,
      eventType,
      eventTimestamp: createdAt,
      providerPaymentId,
      checkoutSessionId,
      capturedAmount,
      currency,
      status,
      rawPayload: payload
    };
  }
}
