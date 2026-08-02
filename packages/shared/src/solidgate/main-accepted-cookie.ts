import type { PaymentEnvironment } from '../payment-environment';
import { buildSolidgateOrderId, parseSolidgateOrderId } from './order-id';

// Purpose-scoped proof that Solidgate accepted a paid main authorization. This
// is deliberately separate from payment_access: auth_ok is still a reservation
// and must not grant account, entitlement, saved-card, or later-OTO authority.
export const SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME = 'solidgate_main_accepted';
export const SOLIDGATE_MAIN_ACCEPTED_MAX_AGE = 60 * 10; // 10 minutes

const COOKIE_VERSION = 'v1';
const SIGNING_PURPOSE = 'solidgate-main-accepted';
const MAX_CLOCK_SKEW_SECONDS = 60;
const MAX_COOKIE_LENGTH = 4096;
const SESSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface SolidgateMainAcceptedCookieBinding {
  orderId: string;
  sessionId: string;
  paymentEnvironment: PaymentEnvironment;
}

interface SolidgateMainAcceptedCookiePayload {
  /** Explicit purpose prevents a broader payment cookie from crossing domains. */
  p: 'solidgate_main_accepted';
  /** Solidgate main order id. */
  o: string;
  /** Funnel session UUID. */
  s: string;
  /** Isolated payment ledger. */
  e: PaymentEnvironment;
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
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToBase64url(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function validBinding(
  binding: Partial<SolidgateMainAcceptedCookieBinding>,
): binding is SolidgateMainAcceptedCookieBinding {
  if (
    typeof binding.orderId !== 'string' ||
    typeof binding.sessionId !== 'string' ||
    !SESSION_UUID_PATTERN.test(binding.sessionId) ||
    (binding.paymentEnvironment !== 'sandbox' && binding.paymentEnvironment !== 'production')
  ) {
    return false;
  }

  const parsed = parseSolidgateOrderId(binding.orderId);
  if (!parsed || parsed.sessionId !== binding.sessionId) return false;

  try {
    return buildSolidgateOrderId(parsed.sessionId, parsed.offeringSlug, parsed.attempt) === binding.orderId;
  } catch {
    return false;
  }
}

function signedData(encodedPayload: string): string {
  return `${SIGNING_PURPOSE}:${COOKIE_VERSION}.${encodedPayload}`;
}

export async function signSolidgateMainAcceptedCookie(
  binding: SolidgateMainAcceptedCookieBinding,
): Promise<string> {
  if (!validBinding(binding)) {
    throw new Error('A valid Solidgate order, session, and payment environment are required');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SolidgateMainAcceptedCookiePayload = {
    p: 'solidgate_main_accepted',
    o: binding.orderId,
    s: binding.sessionId,
    e: binding.paymentEnvironment,
    n: issuedAt,
    x: issuedAt + SOLIDGATE_MAIN_ACCEPTED_MAX_AGE,
  };
  const encodedPayload = stringToBase64url(JSON.stringify(payload));
  const signature = await hmac(signedData(encodedPayload));
  return `${COOKIE_VERSION}.${encodedPayload}.${signature}`;
}

export async function verifySolidgateMainAcceptedCookie(
  value: string,
): Promise<SolidgateMainAcceptedCookieBinding | null> {
  if (!value || value.length > MAX_COOKIE_LENGTH) return null;

  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [version, encodedPayload, signature] = parts;
  if (version !== COOKIE_VERSION || !encodedPayload || !signature) return null;

  const expected = await hmac(signedData(encodedPayload));
  if (!constantTimeEqual(signature, expected)) return null;

  const decoded = base64urlToString(encodedPayload);
  if (!decoded) return null;

  let payload: Partial<SolidgateMainAcceptedCookiePayload>;
  try {
    payload = JSON.parse(decoded) as Partial<SolidgateMainAcceptedCookiePayload>;
  } catch {
    return null;
  }

  const binding = {
    orderId: payload.o,
    sessionId: payload.s,
    paymentEnvironment: payload.e,
  };
  if (
    payload.p !== 'solidgate_main_accepted' ||
    !validBinding(binding) ||
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
    expiresAt - issuedAt > SOLIDGATE_MAIN_ACCEPTED_MAX_AGE
  ) {
    return null;
  }

  return binding;
}
