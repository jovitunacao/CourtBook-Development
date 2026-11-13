// ==============================================================================
// CourtBook / BookSuite — Short-Lived Guest Booking Lookup Token Helper
// Pure Web Crypto implementation (compatible with Deno Edge Functions & Node 22)
// ==============================================================================

const TOKEN_DOMAIN = 'courtbook-guest-lookup-v1';

export interface GuestLookupTokenPayload {
  v: number;
  res: string; // reservation_id (UUID)
  ref: string; // reference_code (CB-...)
  iat: number; // issued at (epoch seconds)
  exp: number; // expires at (epoch seconds)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function deriveHmacKey(rawSecret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(rawSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  // Domain-separate raw secret so service_role key is never directly used as token key
  const derivedBytes = await crypto.subtle.sign('HMAC', baseKey, enc.encode(TOKEN_DOMAIN));
  return crypto.subtle.importKey(
    'raw',
    derivedBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

export async function mintGuestLookupToken(params: {
  reservationId: string;
  referenceCode: string;
  secret: string;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? 86400; // 24 hours default
  const payload: GuestLookupTokenPayload = {
    v: 1,
    res: params.reservationId.trim(),
    ref: params.referenceCode.trim().toUpperCase(),
    iat: now,
    exp: now + ttl,
  };

  const enc = new TextEncoder();
  const payloadB64 = toBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await deriveHmacKey(params.secret, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sigBuffer));

  return `${payloadB64}.${sigB64}`;
}

export async function verifyGuestLookupToken(
  token: string,
  expectedReferenceCode: string,
  secret: string
): Promise<{ valid: boolean; reservationId?: string; reason?: string }> {
  const trimmed = (token || '').trim();
  const parts = trimmed.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: 'Malformed lookup token' };
  }

  const [payloadB64, sigB64] = parts;
  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (!sigBytes || !payloadBytes) {
    return { valid: false, reason: 'Invalid token encoding' };
  }

  try {
    const key = await deriveHmacKey(secret, ['verify']);
    const isVerified = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(payloadB64)
    );
    if (!isVerified) {
      return { valid: false, reason: 'Invalid token signature' };
    }

    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<GuestLookupTokenPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.res !== 'string' ||
      typeof parsed.ref !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return { valid: false, reason: 'Invalid token claims' };
    }

    if (parsed.ref.toUpperCase() !== expectedReferenceCode.trim().toUpperCase()) {
      return { valid: false, reason: 'Token reference code mismatch' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp <= now) {
      return { valid: false, reason: 'Lookup token expired' };
    }

    return { valid: true, reservationId: parsed.res };
  } catch {
    return { valid: false, reason: 'Token verification failure' };
  }
}
