// ==============================================================================
// LockaCourt (AratReserve) — HitPay Sandbox Shared Payment Helper
// File: supabase/functions/_shared/hitpay.ts
//
// Runtime: Compatible with both Supabase Edge Functions (Deno) and Node.js (tsx).
// Stage 2 Restriction: Strictly restricted to HitPay Sandbox environment.
// Live credentials, endpoints, and checkout URLs are explicitly rejected.
// ==============================================================================

export const HITPAY_SANDBOX_API_BASE = 'https://api.sandbox.hit-pay.com';
export const HITPAY_LIVE_API_BASE = 'https://api.hit-pay.com';
export const HITPAY_DEFAULT_TIMEOUT_MS = 12_000;

export interface HitPaySandboxConfig {
  environment: 'sandbox';
  baseUrl: string;
  apiKey: string;
  webhookSalt: string;
  isConfigured: boolean;
  timeoutMs: number;
}

export class HitPayConfigError extends Error {
  readonly code = 'HITPAY_CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'HitPayConfigError';
  }
}

export class HitPayNotConfiguredError extends Error {
  readonly code = 'provider_not_configured';
  constructor(
    message: string = 'provider_not_configured: HitPay sandbox credentials are not configured.'
  ) {
    super(message);
    this.name = 'HitPayNotConfiguredError';
  }
}

export class HitPayValidationError extends Error {
  readonly code = 'HITPAY_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'HitPayValidationError';
  }
}

export class HitPayReconciliationError extends Error {
  readonly code = 'HITPAY_RECONCILIATION_REQUIRED';
  readonly reconciliationRequired = true;
  readonly referenceCode: string;

  constructor(message: string, referenceCode: string) {
    super(message);
    this.name = 'HitPayReconciliationError';
    this.referenceCode = referenceCode;
  }
}

export interface HitPayFetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface HitPayNormalizedEvent {
  providerName: 'hitpay';
  providerEventId: string;
  eventType: string;
  eventTimestamp: string;
  providerPaymentId?: string;
  checkoutSessionId?: string;
  refundId?: string;
  referenceNumber?: string;
  capturedAmount?: number;
  currency?: string;
  status: 'paid' | 'failed' | 'refunded' | 'unknown';
  rawPayload: Record<string, unknown>;
}

export interface HitPayPaymentRequestRecord {
  id: string;
  url: string;
  status: string;
  amount: string;
  currency: string;
  reference_number?: string;
  payment_methods?: string[];
  payments?: Array<Record<string, unknown>>;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface HitPayRefundRecord {
  id: string;
  payment_id?: string;
  charge_id?: string;
  status?: string;
  amount_refunded?: string | number;
  refunded_amount?: string | number;
  amount?: string | number;
  currency?: string;
  reference_number?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export function resolveHitPaySandboxConfig(
  env: Record<string, string | undefined>,
  overrides?: { apiKey?: string; webhookSalt?: string; baseUrl?: string; timeoutMs?: number }
): HitPaySandboxConfig {
  const rawMode = (env.HITPAY_ENV || env.HITPAY_MODE || 'sandbox').trim().toLowerCase();
  if (rawMode !== 'sandbox' && rawMode !== 'test') {
    throw new HitPayConfigError(
      `HitPay environment "${rawMode}" is prohibited in Stage 2. Only sandbox mode is permitted.`
    );
  }

  if (env.HITPAY_ALLOW_LIVE === 'true' || env.HITPAY_LIVE_API_KEY || env.HITPAY_LIVE_WEBHOOK_SALT) {
    throw new HitPayConfigError(
      'Live HitPay credentials or live-mode flags are strictly prohibited in Stage 2 sandbox mode.'
    );
  }

  const configuredBase = (
    overrides?.baseUrl ||
    env.HITPAY_SANDBOX_API_URL ||
    env.HITPAY_API_BASE_URL ||
    env.HITPAY_BASE_URL ||
    HITPAY_SANDBOX_API_BASE
  )
    .trim()
    .replace(/\/+$/, '');

  if (configuredBase !== HITPAY_SANDBOX_API_BASE) {
    throw new HitPayConfigError(
      `Invalid HitPay API base URL "${configuredBase}". Stage 2 strictly requires sandbox endpoint "${HITPAY_SANDBOX_API_BASE}".`
    );
  }

  const apiKey = (
    overrides?.apiKey ||
    env.HITPAY_SANDBOX_API_KEY ||
    env.HITPAY_API_KEY ||
    ''
  ).trim();

  const webhookSalt = (
    overrides?.webhookSalt ||
    env.HITPAY_SANDBOX_WEBHOOK_SALT ||
    env.HITPAY_WEBHOOK_SALT ||
    ''
  ).trim();

  // Reject keys visibly marked as live
  if (/^(live_|hp_live_|sk_live_)/i.test(apiKey) || /^(live_|hp_live_)/i.test(webhookSalt)) {
    throw new HitPayConfigError(
      'Live-prefixed HitPay credentials are strictly rejected in sandbox mode.'
    );
  }

  const parsedTimeout = Number(overrides?.timeoutMs || env.HITPAY_TIMEOUT_MS || HITPAY_DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 1000 && parsedTimeout <= 60_000
      ? parsedTimeout
      : HITPAY_DEFAULT_TIMEOUT_MS;

  return {
    environment: 'sandbox',
    baseUrl: configuredBase,
    apiKey,
    webhookSalt,
    isConfigured: Boolean(apiKey && webhookSalt),
    timeoutMs,
  };
}

export function isHitPaySandboxConfigured(config: HitPaySandboxConfig): boolean {
  return Boolean(config.apiKey && config.webhookSalt);
}

export function assertHitPaySandboxConfigured(config: HitPaySandboxConfig): void {
  if (!config.apiKey || !config.webhookSalt) {
    throw new HitPayNotConfiguredError(
      'provider_not_configured: HitPay sandbox API key and webhook signing secret are not configured.'
    );
  }
}

export function assertHitPayPhpCurrency(currency: string): 'PHP' {
  const trimmed = String(currency || '').trim().toUpperCase();
  if (trimmed === 'PHP' || trimmed === '₱') {
    return 'PHP';
  }
  throw new HitPayValidationError(
    `Unsupported HitPay currency "${currency || 'empty'}". LockaCourt requires PHP.`
  );
}

export function formatCentavosToHitPayDecimal(amountCentavos: number): string {
  if (!Number.isFinite(amountCentavos) || !Number.isInteger(amountCentavos) || amountCentavos <= 0) {
    throw new HitPayValidationError(
      `Invalid HitPay centavos amount "${amountCentavos}". Expected a strictly positive integer.`
    );
  }
  return (amountCentavos / 100).toFixed(2);
}

export function parseHitPayDecimalAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100) / 100;
}

export function isHitPaySandboxCheckoutUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'sandbox.hit-pay.com' || host.endsWith('.sandbox.hit-pay.com');
  } catch {
    return false;
  }
}

export function assertHitPaySandboxPayload(payload: Record<string, unknown>): {
  valid: boolean;
  error?: string;
} {
  if (payload.livemode === true || payload.is_sandbox === false) {
    return { valid: false, error: 'Environment mismatch: live HitPay webhook event rejected in sandbox mode.' };
  }

  const mode = String(payload.mode || payload.environment || '').trim().toLowerCase();
  if (mode === 'live' || mode === 'production') {
    return { valid: false, error: 'Environment mismatch: production/live HitPay payload rejected in sandbox mode.' };
  }

  if (typeof payload.url === 'string' && payload.url.trim().length > 0) {
    if (!isHitPaySandboxCheckoutUrl(payload.url)) {
      return { valid: false, error: 'Environment mismatch: non-sandbox HitPay URL rejected in sandbox mode.' };
    }
  }

  return { valid: true };
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length || aBytes.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export async function verifyHitPayWebhookSignatureAsync(
  rawBody: string,
  signatureHeader: string,
  webhookSalt: string
): Promise<{ isValid: boolean; error?: string }> {
  if (!rawBody || !signatureHeader || !webhookSalt) {
    return { isValid: false, error: 'Missing rawBody, Hitpay-Signature header, or webhook salt.' };
  }

  const normalizedHeader = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedHeader)) {
    return { isValid: false, error: 'Malformed Hitpay-Signature header format (expected 64-char hex digest).' };
  }

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(webhookSalt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(rawBody));
  const computedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (!timingSafeEqualStrings(computedHex, normalizedHeader)) {
    return { isValid: false, error: 'Hitpay-Signature HMAC-SHA256 verification failed.' };
  }

  return { isValid: true };
}

export function normalizeHitPayWebhook(
  payload: Record<string, unknown>,
  headers?: { eventType?: string; eventObject?: string }
): HitPayNormalizedEvent {
  const headerEventType = (headers?.eventType || '').trim().toLowerCase();
  const headerEventObject = (headers?.eventObject || '').trim().toLowerCase();

  let eventType = String(payload.event_type || payload.type || '').trim().toLowerCase();
  if (!eventType) {
    if (headerEventObject && headerEventType) {
      eventType = `${headerEventObject}.${headerEventType}`;
    } else if (headerEventType) {
      eventType = headerEventType;
    }
  }

  const rawId = String(payload.id || '').trim();
  const rawPaymentRequestId = String(
    payload.payment_request_id ||
      (payload.payment_request && typeof payload.payment_request === 'object'
        ? (payload.payment_request as Record<string, unknown>).id
        : '') ||
      ''
  ).trim();

  // Distinguish payment_request webhook vs charge webhook
  const isChargeEvent =
    eventType.startsWith('charge.') ||
    headerEventObject === 'charge' ||
    (rawPaymentRequestId.length > 0 && rawId.length > 0 && rawPaymentRequestId !== rawId);

  if (!eventType) {
    const rawPayloadStatus = String(payload.status || '').trim().toLowerCase();
    if (rawPayloadStatus === 'completed' || rawPayloadStatus === 'succeeded') {
      eventType = isChargeEvent ? 'charge.created' : 'payment_request.completed';
    } else if (rawPayloadStatus === 'refunded' || rawPayloadStatus === 'partially_refunded') {
      eventType = 'charge.updated';
    } else if (rawPayloadStatus === 'failed' || rawPayloadStatus === 'canceled' || rawPayloadStatus === 'cancelled') {
      eventType = isChargeEvent ? 'charge.failed' : 'payment_request.failed';
    } else {
      eventType = 'unknown';
    }
  }

  // Canonicalize bare header values like eventType='completed' & eventObject='payment_request'
  if (eventType === 'completed' && headerEventObject === 'payment_request') {
    eventType = 'payment_request.completed';
  } else if (eventType === 'created' && headerEventObject === 'charge') {
    eventType = 'charge.created';
  }

  const checkoutSessionId = rawPaymentRequestId || (!isChargeEvent ? rawId : '') || undefined;

  const embeddedPayments = Array.isArray(payload.payments) ? payload.payments : [];
  const firstPayment =
    embeddedPayments.length > 0 && embeddedPayments[0] && typeof embeddedPayments[0] === 'object'
      ? (embeddedPayments[0] as Record<string, unknown>)
      : null;

  const providerPaymentId =
    String(
      payload.payment_id ||
        payload.provider_payment_id ||
        (firstPayment ? firstPayment.id : '') ||
        rawId ||
        ''
    ).trim() || undefined;

  const rawStatus = String(payload.status || '').trim().toLowerCase();
  let status: 'paid' | 'failed' | 'refunded' | 'unknown' = 'unknown';

  if (
    eventType === 'payment_request.completed' ||
    eventType === 'charge.created' ||
    (rawStatus === 'completed' || rawStatus === 'succeeded' || rawStatus === 'paid')
  ) {
    if (rawStatus === 'refunded' || rawStatus === 'partially_refunded') {
      status = 'refunded';
    } else if (rawStatus === 'failed' || rawStatus === 'canceled' || rawStatus === 'cancelled') {
      status = 'failed';
    } else {
      status = 'paid';
    }
  } else if (rawStatus === 'refunded' || rawStatus === 'partially_refunded' || eventType.includes('refund')) {
    status = 'refunded';
  } else if (rawStatus === 'failed' || rawStatus === 'canceled' || rawStatus === 'cancelled' || rawStatus === 'expired') {
    status = 'failed';
  }

  const capturedAmount = parseHitPayDecimalAmount(payload.amount) ?? undefined;
  const currencyRaw = String(payload.currency || '').trim().toUpperCase();
  const currency = currencyRaw || undefined;
  const referenceNumber = String(payload.reference_number || '').trim() || undefined;

  const refundObj =
    payload.refund && typeof payload.refund === 'object'
      ? (payload.refund as Record<string, unknown>)
      : null;
  const refundId =
    String(
      payload.refund_id ||
        payload.provider_refund_id ||
        (refundObj ? refundObj.id : '') ||
        ''
    ).trim() || undefined;

  const eventTimestamp =
    String(payload.updated_at || payload.created_at || '').trim() || new Date().toISOString();

  const providerEventId =
    String(payload.event_id || '').trim() ||
    (status === 'refunded' && refundId
      ? `hp_ref_${refundId}_${eventType}`
      : isChargeEvent && rawId
      ? `hp_chg_${rawId}_${eventType}`
      : checkoutSessionId
      ? `hp_pr_${checkoutSessionId}_${eventType}`
      : `hp_evt_${Date.now()}`);

  return {
    providerName: 'hitpay',
    providerEventId,
    eventType,
    eventTimestamp,
    providerPaymentId,
    checkoutSessionId,
    refundId,
    referenceNumber,
    capturedAmount,
    currency,
    status,
    rawPayload: payload,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: HitPayFetchLike
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function getHitPayPaymentRequestStatus(
  paymentRequestId: string,
  config: HitPaySandboxConfig,
  fetchFn: HitPayFetchLike = globalThis.fetch
): Promise<{ ok: boolean; statusCode: number; data?: HitPayPaymentRequestRecord; error?: string }> {
  const cleanId = (paymentRequestId || '').trim();
  if (!cleanId) {
    return { ok: false, statusCode: 400, error: 'Missing HitPay payment request ID.' };
  }
  if (!isHitPaySandboxConfigured(config)) {
    return {
      ok: false,
      statusCode: 503,
      error:
        'provider_not_configured: HitPay sandbox API key and webhook signing secret are required.',
    };
  }

  try {
    const res = await fetchWithTimeout(
      `${config.baseUrl}/v1/payment-requests/${encodeURIComponent(cleanId)}`,
      {
        method: 'GET',
        headers: {
          'X-BUSINESS-API-KEY': config.apiKey,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      config.timeoutMs,
      fetchFn
    );

    const json = (await res.json().catch(() => null)) as HitPayPaymentRequestRecord | null;
    if (!res.ok || !json || typeof json !== 'object') {
      return {
        ok: false,
        statusCode: res.status,
        error: `HitPay payment request lookup failed with status ${res.status}.`,
      };
    }

    return { ok: true, statusCode: res.status, data: json };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'HitPay status request failed';
    return { ok: false, statusCode: 503, error: msg };
  }
}

export async function getHitPayRefundStatus(
  refundId: string,
  config: HitPaySandboxConfig,
  fetchFn: HitPayFetchLike = globalThis.fetch
): Promise<{ ok: boolean; statusCode: number; data?: HitPayRefundRecord; error?: string }> {
  const cleanId = (refundId || '').trim();
  if (!cleanId) {
    return { ok: false, statusCode: 400, error: 'Missing HitPay refund ID.' };
  }
  if (!isHitPaySandboxConfigured(config)) {
    return {
      ok: false,
      statusCode: 503,
      error:
        'provider_not_configured: HitPay sandbox API key and webhook signing secret are required.',
    };
  }

  try {
    const res = await fetchWithTimeout(
      `${config.baseUrl}/v1/refund/${encodeURIComponent(cleanId)}`,
      {
        method: 'GET',
        headers: {
          'X-BUSINESS-API-KEY': config.apiKey,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      config.timeoutMs,
      fetchFn
    );

    const json = (await res.json().catch(() => null)) as HitPayRefundRecord | null;
    if (!res.ok || !json || typeof json !== 'object') {
      return {
        ok: false,
        statusCode: res.status,
        error: `HitPay refund lookup failed with status ${res.status}.`,
      };
    }

    return { ok: true, statusCode: res.status, data: json };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'HitPay refund lookup failed';
    return { ok: false, statusCode: 503, error: msg };
  }
}

export async function findHitPayPaymentRequestByReference(
  referenceCode: string,
  expectedAmountCentavos: number,
  config: HitPaySandboxConfig,
  existingRequestId?: string,
  fetchFn: HitPayFetchLike = globalThis.fetch
): Promise<HitPayPaymentRequestRecord | null> {
  const expectedDecimal = Number((expectedAmountCentavos / 100).toFixed(2));

  const isMatchingActiveRecord = (rec: unknown): rec is HitPayPaymentRequestRecord => {
    if (!rec || typeof rec !== 'object') return false;
    const r = rec as Record<string, unknown>;
    const recRef = String(r.reference_number || '').trim();
    const recId = String(r.id || '').trim();
    const recUrl = String(r.url || '').trim();
    const recStatus = String(r.status || '').trim().toLowerCase();
    const recCurrency = String(r.currency || '').trim().toUpperCase();
    const recAmount = parseHitPayDecimalAmount(r.amount);

    return (
      recId.length > 0 &&
      recRef === referenceCode &&
      recCurrency === 'PHP' &&
      recAmount !== null &&
      Math.abs(recAmount - expectedDecimal) < 0.001 &&
      (recStatus === 'pending' || recStatus === 'completed') &&
      isHitPaySandboxCheckoutUrl(recUrl)
    );
  };

  if (existingRequestId && !existingRequestId.startsWith('cs_pending_')) {
    const direct = await getHitPayPaymentRequestStatus(existingRequestId, config, fetchFn);
    if (direct.ok && isMatchingActiveRecord(direct.data)) {
      return direct.data;
    }
  }

  try {
    const res = await fetchWithTimeout(
      `${config.baseUrl}/v1/payment-requests?search=${encodeURIComponent(referenceCode)}`,
      {
        method: 'GET',
        headers: {
          'X-BUSINESS-API-KEY': config.apiKey,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      config.timeoutMs,
      fetchFn
    );

    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | unknown[] | null;
    const items = Array.isArray(body)
      ? body
      : body && Array.isArray(body.data)
      ? body.data
      : [];

    for (const item of items) {
      if (isMatchingActiveRecord(item)) {
        return item;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface CreateHitPayRequestInput {
  amountCentavos: number;
  currency: string;
  description: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  referenceCode: string;
  successUrl: string;
  webhookUrl?: string;
  expiresAt?: string;
  paymentMethods?: string[];
  isIdempotentReplay?: boolean;
  existingRequestId?: string;
}

export async function createHitPaySandboxPaymentRequest(
  params: CreateHitPayRequestInput,
  config: HitPaySandboxConfig,
  fetchFn: HitPayFetchLike = globalThis.fetch
): Promise<{
  providerCheckoutId: string;
  checkoutUrl: string;
  isSimulated: false;
  recovered: boolean;
  rawResponse: Record<string, unknown>;
}> {
  assertHitPaySandboxConfigured(config);

  const currency = assertHitPayPhpCurrency(params.currency);
  const decimalAmount = formatCentavosToHitPayDecimal(params.amountCentavos);

  // On idempotent replay, ONLY recover existing active request; never issue a duplicate POST.
  if (params.isIdempotentReplay) {
    const existing = await findHitPayPaymentRequestByReference(
      params.referenceCode,
      params.amountCentavos,
      config,
      params.existingRequestId,
      fetchFn
    );
    if (existing) {
      return {
        providerCheckoutId: existing.id,
        checkoutUrl: existing.url,
        isSimulated: false,
        recovered: true,
        rawResponse: existing,
      };
    }
    throw new HitPayReconciliationError(
      'Checkout session recovery failed or no active HitPay sandbox request found. Booking marked for reconciliation; refusing to create a duplicate payable session.',
      params.referenceCode
    );
  }

  const formParams = new URLSearchParams();
  formParams.set('amount', decimalAmount);
  formParams.set('currency', currency);
  formParams.set('reference_number', params.referenceCode);
  formParams.set('purpose', params.description);
  formParams.set('name', params.customerName);
  formParams.set('redirect_url', params.successUrl);
  formParams.set('allow_repeated_payments', 'false');
  formParams.set('send_sms', 'false');
  formParams.set('send_email', params.customerEmail ? 'true' : 'false');

  if (params.customerEmail) formParams.set('email', params.customerEmail);
  if (params.customerPhone) formParams.set('phone', params.customerPhone);
  if (params.webhookUrl) formParams.set('webhook', params.webhookUrl);
  if (params.expiresAt) formParams.set('expiry_date', params.expiresAt);
  if (params.paymentMethods && params.paymentMethods.length > 0) {
    for (const method of params.paymentMethods) {
      const cleanMethod = String(method || '').trim();
      if (cleanMethod) {
        formParams.append('payment_methods[]', cleanMethod);
      }
    }
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${config.baseUrl}/v1/payment-requests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-BUSINESS-API-KEY': config.apiKey,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formParams.toString(),
      },
      config.timeoutMs,
      fetchFn
    );
  } catch {
    // Ambiguous network error or timeout: attempt safe read-only recovery before failing closed
    const recovered = await findHitPayPaymentRequestByReference(
      params.referenceCode,
      params.amountCentavos,
      config,
      params.existingRequestId,
      fetchFn
    );
    if (recovered) {
      return {
        providerCheckoutId: recovered.id,
        checkoutUrl: recovered.url,
        isSimulated: false,
        recovered: true,
        rawResponse: recovered,
      };
    }
    throw new HitPayReconciliationError(
      'HitPay sandbox request timed out or encountered an ambiguous network failure. Booking marked for reconciliation.',
      params.referenceCode
    );
  }

  if (response.status >= 500) {
    const recovered = await findHitPayPaymentRequestByReference(
      params.referenceCode,
      params.amountCentavos,
      config,
      params.existingRequestId,
      fetchFn
    );
    if (recovered) {
      return {
        providerCheckoutId: recovered.id,
        checkoutUrl: recovered.url,
        isSimulated: false,
        recovered: true,
        rawResponse: recovered,
      };
    }
    throw new HitPayReconciliationError(
      `HitPay sandbox returned server error (${response.status}). Booking marked for reconciliation.`,
      params.referenceCode
    );
  }

  const rawJson = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !rawJson) {
    throw new Error(`HitPay Payment Request API failed with status ${response.status}.`);
  }

  const providerCheckoutId = String(rawJson.id || '').trim();
  const checkoutUrl = String(rawJson.url || '').trim();

  if (!providerCheckoutId || !checkoutUrl) {
    throw new Error('HitPay API response missing payment request ID or checkout URL.');
  }

  if (!isHitPaySandboxCheckoutUrl(checkoutUrl)) {
    throw new HitPayConfigError(
      `HitPay returned non-sandbox checkout URL "${checkoutUrl}" while running in Stage 2 sandbox mode.`
    );
  }

  const responseCurrency = String(rawJson.currency || 'PHP').trim().toUpperCase();
  if (responseCurrency !== 'PHP') {
    throw new HitPayValidationError(
      `HitPay returned unexpected currency "${responseCurrency}" instead of PHP.`
    );
  }

  return {
    providerCheckoutId,
    checkoutUrl,
    isSimulated: false,
    recovered: false,
    rawResponse: rawJson,
  };
}
