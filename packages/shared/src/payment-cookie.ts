// Short-lived, session-bound payment access cookie. Web Crypto keeps this
// module compatible with both Node and Edge runtimes.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PAYMENT_COOKIE_NAME = 'payment_access';
export const PAYMENT_COOKIE_MAX_AGE = 60 * 90; // 90 minutes

const COOKIE_VERSION = 'v2';
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_COOKIE_LENGTH = 4096;

export type PaymentCookieKind = 'pi' | 'sub';

export interface VerifiedPaymentCookie {
  kind: PaymentCookieKind;
  id: string;
  sessionId: string;
  /** Legacy alias for `id` when kind='pi'; null when kind='sub'. */
  paymentIntentId: string | null;
  /** Present when kind='sub'; null when kind='pi'. */
  subscriptionId: string | null;
}

interface PaymentCookiePayload {
  /** Payment reference kind. */
  k: PaymentCookieKind;
  /** Solidgate order/subscription reference. */
  i: string;
  /** Funnel session id. */
  s: string;
  /** Issued-at Unix timestamp in seconds. */
  n: number;
  /** Expiry Unix timestamp in seconds. */
  x: number;
}

function getSecret(): string {
  const secret = process.env.PAYMENT_COOKIE_SECRET;
  if (!secret) throw new Error('PAYMENT_COOKIE_SECRET env var is not set');
  return secret;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function stringToBase64url(value: string): string {
  return bytesToBase64url(enc.encode(value));
}

function base64urlToString(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return dec.decode(bytes);
  } catch {
    return null;
  }
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToBase64url(new Uint8Array(sig));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

export async function signPaymentCookie(
  id: string,
  sessionId: string,
  opts?: { kind?: PaymentCookieKind },
): Promise<string> {
  const kind = opts?.kind ?? 'pi';
  if (!id || !sessionId) throw new Error('Payment cookie id and sessionId are required');

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: PaymentCookiePayload = {
    k: kind,
    i: id,
    s: sessionId,
    n: issuedAt,
    x: issuedAt + PAYMENT_COOKIE_MAX_AGE,
  };
  const encodedPayload = stringToBase64url(JSON.stringify(payload));
  const signedData = `${COOKIE_VERSION}.${encodedPayload}`;
  const signature = await hmac(signedData);
  return `${signedData}.${signature}`;
}

export async function verifyPaymentCookie(
  cookieValue: string,
): Promise<VerifiedPaymentCookie | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null;

  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [version, encodedPayload, signature] = parts;
  if (version !== COOKIE_VERSION || !encodedPayload || !signature) return null;

  const expected = await hmac(`${version}.${encodedPayload}`);
  if (!constantTimeEqual(signature, expected)) return null;

  const decoded = base64urlToString(encodedPayload);
  if (!decoded) return null;

  let payload: Partial<PaymentCookiePayload>;
  try {
    payload = JSON.parse(decoded) as Partial<PaymentCookiePayload>;
  } catch {
    return null;
  }

  if (
    (payload.k !== 'pi' && payload.k !== 'sub') ||
    typeof payload.i !== 'string' ||
    payload.i.length === 0 ||
    typeof payload.s !== 'string' ||
    payload.s.length === 0 ||
    !Number.isInteger(payload.n) ||
    !Number.isInteger(payload.x)
  ) {
    return null;
  }

  const issuedAt = payload.n as number;
  const expiresAt = payload.x as number;
  const now = Math.floor(Date.now() / 1000);
  if (
    issuedAt > now + MAX_CLOCK_SKEW_SECONDS ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > PAYMENT_COOKIE_MAX_AGE
  ) {
    return null;
  }

  const kind = payload.k;
  const id = payload.i;
  return {
    kind,
    id,
    sessionId: payload.s,
    paymentIntentId: kind === 'pi' ? id : null,
    subscriptionId: kind === 'sub' ? id : null,
  };
}
