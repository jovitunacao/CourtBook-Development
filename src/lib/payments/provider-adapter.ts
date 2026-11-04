// ==============================================================================
// CourtBook / BookSuite — Payment Provider Registry & Adapter Factory
// File: src/lib/payments/provider-adapter.ts
// ==============================================================================

import type { PaymentProviderAdapter, PaymentProviderName, WebhookVerificationResult, NormalizedWebhookEvent } from './types';
import { PayMongoAdapter } from './paymongo-adapter';

/**
 * Xendit Provider Adapter Stub
 * Explicitly marked NOT READY per security requirements until official Xendit credentials
 * and webhook signing specifications are configured.
 */
export class XenditAdapter implements PaymentProviderAdapter {
  readonly providerName = 'xendit';
  readonly isReady = false;

  verifyWebhookSignature(): WebhookVerificationResult {
    return {
      isValid: false,
      error: 'Xendit payment provider adapter is marked NOT READY. Official production integration pending.'
    };
  }

  normalizeWebhook(payload: Record<string, unknown>): NormalizedWebhookEvent {
    return {
      providerName: 'xendit',
      providerEventId: String(payload.id || 'unsupported'),
      eventType: 'unsupported',
      eventTimestamp: new Date().toISOString(),
      status: 'unknown',
      rawPayload: payload
    };
  }
}

export class PaymentProviderRegistry {
  private static adapters: Map<PaymentProviderName, PaymentProviderAdapter> = new Map<PaymentProviderName, PaymentProviderAdapter>([
    ['paymongo', new PayMongoAdapter()],
    ['xendit', new XenditAdapter()]
  ]);

  static getAdapter(name: PaymentProviderName): PaymentProviderAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Unsupported payment provider: "${name}".`);
    }
    return adapter;
  }
}
