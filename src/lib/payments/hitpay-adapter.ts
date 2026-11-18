// ==============================================================================
// LockaCourt (AratReserve) — HitPay Sandbox Provider Adapter
// File: src/lib/payments/hitpay-adapter.ts
// ==============================================================================

import crypto from 'node:crypto';
import type {
  PaymentProviderAdapter,
  WebhookVerificationResult,
  NormalizedWebhookEvent,
  ProviderCheckoutSessionParams,
  ProviderCheckoutSessionResult,
} from './types';
import {
  createHitPaySandboxPaymentRequest,
  getHitPayPaymentRequestStatus,
  normalizeHitPayWebhook,
  resolveHitPaySandboxConfig,
  type HitPayFetchLike,
} from '../../../supabase/functions/_shared/hitpay.ts';

export interface HitPayAdapterOptions {
  fetchFn?: HitPayFetchLike;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export class HitPayAdapter implements PaymentProviderAdapter {
  readonly providerName = 'hitpay' as const;
  readonly isReady = true;

  private readonly fetchFn: HitPayFetchLike;
  private readonly envOverrides?: Record<string, string | undefined>;
  private readonly timeoutMs?: number;

  constructor(options?: HitPayAdapterOptions) {
    this.fetchFn = options?.fetchFn || globalThis.fetch;
    this.envOverrides = options?.env;
    this.timeoutMs = options?.timeoutMs;
  }

  private getRuntimeEnv(): Record<string, string | undefined> {
    if (this.envOverrides) return this.envOverrides;
    return typeof process !== 'undefined' && process.env
      ? (process.env as Record<string, string | undefined>)
      : {};
  }

  /**
   * Returns true only when sandbox configuration is valid and an API key is available.
   */
  isConfigured(secretKey?: string): boolean {
    try {
      const cfg = resolveHitPaySandboxConfig(this.getRuntimeEnv(), {
        apiKey: secretKey,
        timeoutMs: this.timeoutMs,
      });
      return Boolean(cfg.apiKey);
    } catch {
      return false;
    }
  }

  /**
   * Creates a HitPay Sandbox Payment Request (POST https://api.sandbox.hit-pay.com/v1/payment-requests).
   * Enforces PHP currency, decimal amount formatting, sandbox-only isolation, and safe timeout recovery.
   */
  async createCheckoutSession(
    params: ProviderCheckoutSessionParams,
    secretKey?: string
  ): Promise<ProviderCheckoutSessionResult> {
    const config = resolveHitPaySandboxConfig(this.getRuntimeEnv(), {
      apiKey: secretKey,
      timeoutMs: this.timeoutMs,
    });

    const res = await createHitPaySandboxPaymentRequest(
      {
        amountCentavos: params.amountCentavos,
        currency: params.currency,
        description: params.description,
        customerName: params.customerName,
        customerPhone: params.customerPhone,
        customerEmail: params.customerEmail,
        referenceCode: params.referenceCode,
        successUrl: params.successUrl,
        webhookUrl: params.webhookUrl,
        expiresAt: params.expiresAt,
      },
      config,
      this.fetchFn
    );

    return {
      providerCheckoutId: res.providerCheckoutId,
      checkoutUrl: res.checkoutUrl,
      isSimulated: false,
      rawResponse: res.rawResponse,
    };
  }

  /**
   * Authoritatively retrieves a HitPay Sandbox Payment Request by ID.
   */
  async getPaymentRequestStatus(paymentRequestId: string, secretKey?: string) {
    const config = resolveHitPaySandboxConfig(this.getRuntimeEnv(), {
      apiKey: secretKey,
      timeoutMs: this.timeoutMs,
    });
    return getHitPayPaymentRequestStatus(paymentRequestId, config, this.fetchFn);
  }

  /**
   * Verifies HitPay dashboard webhook signatures using HMAC-SHA256 over the exact raw request body.
   * Header: Hitpay-Signature (64-char hex digest generated with the per-webhook salt).
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    webhookSecret: string,
    _toleranceSeconds?: number
  ): WebhookVerificationResult {
    if (!rawBody || !signatureHeader || !webhookSecret) {
      return {
        isValid: false,
        error: 'Missing rawBody, Hitpay-Signature header, or HitPay webhook salt.',
      };
    }

    const normalizedHeader = signatureHeader.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHeader)) {
      return {
        isValid: false,
        error: 'Malformed Hitpay-Signature header format (expected 64-char hex digest).',
      };
    }

    const computedHex = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody, 'utf8')
      .digest('hex')
      .toLowerCase();

    const computedBuf = Buffer.from(computedHex, 'utf8');
    const receivedBuf = Buffer.from(normalizedHeader, 'utf8');

    if (
      computedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(computedBuf, receivedBuf)
    ) {
      return {
        isValid: false,
        error: 'Computed HitPay HMAC-SHA256 signature does not match Hitpay-Signature header.',
      };
    }

    return {
      isValid: true,
      mode: 'test',
    };
  }

  normalizeWebhook(payload: Record<string, unknown>): NormalizedWebhookEvent {
    const normalized = normalizeHitPayWebhook(payload);
    return {
      providerName: normalized.providerName,
      providerEventId: normalized.providerEventId,
      eventType: normalized.eventType,
      eventTimestamp: normalized.eventTimestamp,
      providerPaymentId: normalized.providerPaymentId,
      checkoutSessionId: normalized.checkoutSessionId,
      capturedAmount: normalized.capturedAmount,
      currency: normalized.currency,
      status: normalized.status,
      rawPayload: normalized.rawPayload,
    };
  }
}
