// ==============================================================================
// LockaCourt (AratReserve) — Canonical Domain & Auth Redirect Helpers
// File: src/lib/appUrl.ts
//
// Centralizes public domain identity (https://lockacourt.com) and safe redirect
// resolution across local development, preview builds, and production.
// ==============================================================================

export const BRAND_NAME = 'LockaCourt';
export const PARENT_BUSINESS_NAME = 'AratReserve';
export const PARENT_BUSINESS_URL = 'https://aratreserve.com';
export const CANONICAL_APP_BASE_URL = 'https://lockacourt.com';

const WWW_LOCKACOURT_ORIGIN = 'https://www.lockacourt.com';

/**
 * Normalizes trailing slashes and canonicalizes www.lockacourt.com to https://lockacourt.com.
 */
export function normalizeAppOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed) return CANONICAL_APP_BASE_URL;
  if (trimmed.toLowerCase() === WWW_LOCKACOURT_ORIGIN) {
    return CANONICAL_APP_BASE_URL;
  }
  return trimmed;
}

/**
 * Resolves the active application base URL cleanly:
 *  1. Explicit `VITE_APP_BASE_URL` env var when configured (normalized).
 *  2. `window.location.origin` in browser runtimes (preserving localhost / staging previews,
 *     and canonicalizing www.lockacourt.com -> https://lockacourt.com).
 *  3. Falls back to `https://lockacourt.com` in server/test runtimes.
 */
export function getAppBaseUrl(): string {
  const envMeta =
    typeof import.meta !== 'undefined' && (import.meta as any).env
      ? (import.meta as any).env
      : {};
  const envProc =
    typeof process !== 'undefined' && process.env ? process.env : {};

  const configuredUrl = (
    envMeta.VITE_APP_BASE_URL ||
    envProc.VITE_APP_BASE_URL ||
    ''
  ).trim();

  if (configuredUrl && /^https?:\/\//i.test(configuredUrl)) {
    return normalizeAppOrigin(configuredUrl);
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    const winOrigin = window.location.origin;
    if (/^https?:\/\//i.test(winOrigin)) {
      return normalizeAppOrigin(winOrigin);
    }
  }

  return CANONICAL_APP_BASE_URL;
}

/**
 * Canonical redirect URL passed to Supabase Auth verification emails and password resets.
 */
export function getAuthEmailRedirectUrl(targetPath = '/admin'): string {
  const base = getAppBaseUrl();
  const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return `${base}${normalizedPath}`;
}
