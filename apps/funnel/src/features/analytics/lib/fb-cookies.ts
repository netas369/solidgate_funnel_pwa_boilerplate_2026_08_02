'use client';

/**
 * Helpers for the Meta Pixel attribution cookies (_fbp, _fbc).
 *
 * Meta's fbevents.js sets these automatically when it loads with `fbclid`
 * in the URL — but we observed cases where the library was slow to execute
 * or returned an empty body, leaving `_fbc` unset and breaking ad-click
 * attribution. We set the cookie manually as a backstop and read both
 * cookies for the server-side Conversions API payload.
 *
 * Cookie format (per Meta docs):
 *   _fbp = fb.{subdomainIndex}.{timestamp_ms}.{random}
 *   _fbc = fb.{subdomainIndex}.{timestamp_ms}.{fbclid}
 *
 * subdomainIndex: 0 = .com, 1 = .example.com, 2 = www.example.com, etc.
 * We use 1 (eTLD+1), which matches the cookie scope `.example.com`.
 */

const FBC_COOKIE = '_fbc';
const FBP_COOKIE = '_fbp';
const NINETY_DAYS_SECONDS = 60 * 60 * 24 * 90;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string, maxAge: number): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

/**
 * Read fbclid from the current URL and write the `_fbc` cookie in Meta's
 * canonical format. No-ops if `_fbc` already exists (the library or an
 * earlier visit already set it) or if no fbclid is present.
 *
 * Idempotent and safe to call on every page mount.
 */
export function captureFbclidToCookie(): void {
  if (typeof window === 'undefined') return;

  const fbclid = new URLSearchParams(window.location.search).get('fbclid');
  if (!fbclid) return;
  if (readCookie(FBC_COOKIE)) return;

  const value = `fb.1.${Date.now()}.${fbclid}`;
  writeCookie(FBC_COOKIE, value, NINETY_DAYS_SECONDS);
}

/**
 * Ensure CAPI has a stable first-party browser identifier even when the Pixel
 * script is delayed or blocked before it can create `_fbp` itself.
 */
export function ensureFbpCookie(): void {
  if (typeof window === 'undefined' || readCookie(FBP_COOKIE)) return;
  const random = new Uint32Array(2);
  window.crypto.getRandomValues(random);
  const browserId = `${random[0]}${random[1]}`;
  writeCookie(FBP_COOKIE, `fb.1.${Date.now()}.${browserId}`, NINETY_DAYS_SECONDS);
}

/**
 * Read the `_fbc` cookie (set by fbevents.js or captureFbclidToCookie).
 * Returns null if not present.
 */
export function getFbcCookie(): string | null {
  return readCookie(FBC_COOKIE);
}

/**
 * Read the `_fbp` cookie (set by fbevents.js on init).
 * Returns null if not present.
 */
export function getFbpCookie(): string | null {
  return readCookie(FBP_COOKIE);
}
