/**
 * Origins the funnel legitimately runs on and may hand to Solidgate as
 * return destinations.
 *
 * success_url / OTO return URLs load inside the payment form's iframe, where
 * our CSP frame-src only allows 'self' — so any URL we give Solidgate MUST be
 * same-origin with the page the buyer is actually on. NEXT_PUBLIC_FUNNEL_URL
 * alone breaks two real cases: preview deployments (different host entirely)
 * and www vs apex on production (page served on www.funnel.example.com while
 * the env var says funnel.example.com — different origin, framing blocked,
 * buyer sees "payment_error" after a successful charge).
 */

/** Configured public origin plus its www/apex sibling. */
export function configuredFunnelOrigins(): Set<string> {
  const configured = process.env.NEXT_PUBLIC_FUNNEL_URL;
  const origins = new Set<string>();
  if (!configured) return origins;
  try {
    const url = new URL(configured);
    origins.add(url.origin);
    const siblingHost = url.hostname.startsWith('www.')
      ? url.hostname.slice(4)
      : `www.${url.hostname}`;
    origins.add(`${url.protocol}//${siblingHost}${url.port ? `:${url.port}` : ''}`);
  } catch {
    // Malformed env value — behave as if unset.
  }
  return origins;
}

/**
 * The origin payment flows should return the buyer to: the request's own
 * origin whenever it is trusted (always off production; on production when it
 * is the configured host or its www/apex sibling), otherwise the configured
 * public origin.
 */
export function paymentReturnOrigin(request: Request): string {
  const requestOrigin = new URL(request.url).origin;
  if (process.env.VERCEL_ENV !== 'production') return requestOrigin;
  const allowed = configuredFunnelOrigins();
  if (allowed.size === 0 || allowed.has(requestOrigin)) return requestOrigin;
  return new URL(process.env.NEXT_PUBLIC_FUNNEL_URL!).origin;
}
