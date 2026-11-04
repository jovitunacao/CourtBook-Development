// ==============================================================================
// CourtBook / BookSuite — Payment Provider Registry & Adapter Factory
// File: src/lib/payments/provider-adapter.ts
// ==============================================================================

import type {
  PaymentProviderAdapter,
  PaymentProviderName,
  WebhookVerificationResult,
  NormalizedWebhookEvent,
  ProviderCheckoutSessionParams,
  ProviderCheckoutSessionResult
} from './types';
import { PayMongoAdapter } from './paymongo-adapter';

/**
 * Xendit Provider Adapter Stub
 * Explicitly marked NOT READY per security requirements until official Xendit credentials
 * and webhook signing specifications are configured.
 */
export class XenditAdapter implements PaymentProviderAdapter {
  readonly providerName = 'xendit';
  readonly isReady = false;

  async createCheckoutSession(): Promise<ProviderCheckoutSessionResult> {
    throw new Error('Xendit payment provider adapter is marked NOT READY. Official production integration pending.');
  }

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

/**
 * Manual / Simulated Test Adapter
 * Explicitly marked for isolated offline testing and fixture simulation.
 */
export class ManualTestAdapter implements PaymentProviderAdapter {
  readonly providerName = 'manual_test';
  readonly isReady = true;

  async createCheckoutSession(params: ProviderCheckoutSessionParams): Promise<ProviderCheckoutSessionResult> {
    const simulatedId = `cs_manual_${params.referenceCode}`;
    return {
      providerCheckoutId: simulatedId,
      checkoutUrl: `https://courtbook.app/test-checkout/${simulatedId}`,
      isSimulated: true,
      rawResponse: {
        simulated: true,
        provider: 'manual_test',
        amount: params.amountCentavos,
        reference: params.referenceCode
      }
    };
  }

  verifyWebhookSignature(): WebhookVerificationResult {
    return { isValid: true, mode: 'test' };
  }

  normalizeWebhook(payload: Record<string, unknown>): NormalizedWebhookEvent {
    return {
      providerName: 'manual_test',
      providerEventId: String(payload.id || 'test_event'),
      eventType: 'payment.paid',
      eventTimestamp: new Date().toISOString(),
      status: 'paid',
      rawPayload: payload
    };
  }
}

export class PaymentProviderRegistry {
  private static adapters: Map<PaymentProviderName, PaymentProviderAdapter> = new Map<PaymentProviderName, PaymentProviderAdapter>([
    ['paymongo', new PayMongoAdapter()],
    ['xendit', new XenditAdapter()],
    ['manual_test', new ManualTestAdapter()]
  ]);

  static getAdapter(name: PaymentProviderName): PaymentProviderAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Unsupported payment provider: "${name}".`);
    }
    return adapter;
  }
}
