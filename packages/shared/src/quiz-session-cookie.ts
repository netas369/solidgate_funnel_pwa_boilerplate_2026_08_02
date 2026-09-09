const COOKIE_VERSION = 'q1';
const MAX_CLOCK_SKEW_SECONDS = 60;
const MAX_COOKIE_LENGTH = 2048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const QUIZ_SESSION_COOKIE_NAME = 'quiz_session_access';
export const QUIZ_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

interface QuizSessionCookiePayload {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

function getSecret(): string {
  const secret = process.env.PAYMENT_COOKIE_SECRET;
  if (!secret) throw new Error('PAYMENT_COOKIE_SECRET env var is not set');
  return `quiz-session:${secret}`;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function stringToBase64url(value: string): string {
  return bytesToBase64url(encoder.encode(value));
}

function base64urlToString(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return bytesToBase64url(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function signQuizSessionCookie(sessionId: string): Promise<string> {
  if (!sessionId) throw new Error('Quiz session id is required');

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: QuizSessionCookiePayload = {
    sessionId,
    issuedAt,
    expiresAt: issuedAt + QUIZ_SESSION_COOKIE_MAX_AGE,
  };
  const encodedPayload = stringToBase64url(JSON.stringify(payload));
  const signedData = `${COOKIE_VERSION}.${encodedPayload}`;
  const signature = await hmac(signedData);
  return `${signedData}.${signature}`;
}

export async function verifyQuizSessionCookie(cookieValue: string): Promise<string | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null;

  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [version, encodedPayload, signature] = parts;
  if (version !== COOKIE_VERSION || !encodedPayload || !signature) return null;

  const expected = await hmac(`${version}.${encodedPayload}`);
  if (!constantTimeEqual(signature, expected)) return null;

  const decoded = base64urlToString(encodedPayload);
  if (!decoded) return null;

  let payload: Partial<QuizSessionCookiePayload>;
  try {
    payload = JSON.parse(decoded) as Partial<QuizSessionCookiePayload>;
  } catch {
    return null;
  }

  if (
    typeof payload.sessionId !== 'string' ||
    payload.sessionId.length === 0 ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt)
  ) {
    return null;
  }

  const issuedAt = payload.issuedAt as number;
  const expiresAt = payload.expiresAt as number;
  const now = Math.floor(Date.now() / 1000);
  if (
    issuedAt > now + MAX_CLOCK_SKEW_SECONDS ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > QUIZ_SESSION_COOKIE_MAX_AGE
  ) {
    return null;
  }

  return payload.sessionId;
}
