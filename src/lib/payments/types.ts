// ==============================================================================
// CourtBook / BookSuite — Payment Integration Types
// File: src/lib/payments/types.ts
// ==============================================================================

export type PaymentProviderName = 'paymongo' | 'xendit' | 'manual_test';

export interface CheckoutSessionParams {
  idempotencyKey: string;
  facilityId: string;
  courtId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  bookingDate: string; // YYYY-MM-DD
  startTime: string;   // ISO 8601
  durationMinutes: number;
  providerName?: PaymentProviderName;
}

export interface CheckoutSessionResult {
  success: boolean;
  reservationId: string;
  paymentId: string;
  referenceCode: string;
  checkoutSessionId: string;
  expectedAmount: number;
  currency: string;
  commissionRate: number;
  commissionAmount: number;
  ownerGrossShare: number;
  holdExpiresAt: string;
  timeSlotLabel: string;
  courtName: string;
  checkoutUrl?: string;
  idempotentReplayed?: boolean;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  timestamp?: number;
  mode?: 'test' | 'live';
  error?: string;
}

export interface NormalizedWebhookEvent {
  providerName: PaymentProviderName;
  providerEventId: string;
  eventType: string;
  eventTimestamp: string;
  providerPaymentId?: string;
  checkoutSessionId?: string;
  capturedAmount?: number;
  currency?: string;
  status: 'paid' | 'failed' | 'refunded' | 'unknown';
  rawPayload: Record<string, unknown>;
}

export interface PaymentProviderAdapter {
  readonly providerName: PaymentProviderName;
  readonly isReady: boolean;
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    webhookSecret: string,
    toleranceSeconds?: number
  ): WebhookVerificationResult;
  normalizeWebhook(payload: Record<string, unknown>): NormalizedWebhookEvent;
}
