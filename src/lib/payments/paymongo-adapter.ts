// ==============================================================================
// CourtBook / BookSuite — PayMongo Provider Adapter
// File: src/lib/payments/paymongo-adapter.ts
// ==============================================================================

import crypto from 'node:crypto';
import type {
  PaymentProviderAdapter,
  WebhookVerificationResult,
  NormalizedWebhookEvent,
  ProviderCheckoutSessionParams,
  ProviderCheckoutSessionResult
} from './types';

export class PayMongoAdapter implements PaymentProviderAdapter {
  readonly providerName = 'paymongo';
  readonly isReady = true;

  /**
   * Creates a checkout session using PayMongo API with server-authoritative amount and currency.
   * If PAYMONGO_SECRET_KEY is configured with a valid sk_live_ or sk_test_ key, calls official PayMongo API.
   * If in simulated/sandbox mode without keys, returns a clearly marked simulated checkout session.
   */
  async createCheckoutSession(
    params: ProviderCheckoutSessionParams,
    secretKey?: string
  ): Promise<ProviderCheckoutSessionResult> {
    const key = secretKey || (typeof process !== 'undefined' ? process.env?.PAYMONGO_SECRET_KEY : '') || '';
    const hasLiveOrTestKey = key.startsWith('sk_live_') || key.startsWith('sk_test_');

    if (!hasLiveOrTestKey) {
      // Clearly separated simulated sandbox mode when real gateway secret is not configured
      const simulatedId = `cs_sandbox_${params.referenceCode}_${crypto.randomBytes(4).toString('hex')}`;
      return {
        providerCheckoutId: simulatedId,
        checkoutUrl: `https://test-checkout.paymongo.com/sandbox/${simulatedId}`,
        isSimulated: true,
        rawResponse: {
          simulated: true,
          provider: 'paymongo',
          amount: params.amountCentavos,
          currency: params.currency,
          reference: params.referenceCode
        }
      };
    }

    const authHeader = 'Basic ' + Buffer.from(`${key}:`).toString('base64');
    const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        data: {
          attributes: {
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            description: params.description,
            line_items: [
              {
                currency: params.currency,
                amount: params.amountCentavos,
                name: params.description,
                quantity: 1
              }
            ],
            payment_method_types: ['card', 'gcash', 'paymaya', 'grab_pay'],
            reference_number: params.referenceCode,
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            metadata: params.metadata || {}
          }
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PayMongo Checkout API error (${response.status}): ${errText}`);
    }

    const resJson = await response.json();
    const data = resJson.data;
    return {
      providerCheckoutId: data.id,
      checkoutUrl: data.attributes.checkout_url,
      isSimulated: false,
      rawResponse: resJson
    };
  }

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
