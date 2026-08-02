// Validate the Solidgate payment env at Next.js process startup, before any
// payment route handler is loaded. A missing key throws here (loud fail)
// rather than producing a dead checkout downstream — App Router route handlers
// are independent module graphs, so per-route wiring would be fragile.

const REQUIRED_PAYMENT_ENV = [
  'SOLIDGATE_API_PUBLIC_KEY',
  'SOLIDGATE_API_SECRET_KEY',
] as const;

export function register() {
  const missing = REQUIRED_PAYMENT_ENV.filter((key) => !process.env[key]);
  if (missing.length === 0) return;

  const message = `[env] Missing Solidgate payment env: ${missing.join(', ')}`;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(message);
  }
  console.warn(`${message}\n[env] Checkout will fail until these are set.`);
}
