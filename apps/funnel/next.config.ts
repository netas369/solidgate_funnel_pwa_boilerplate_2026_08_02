import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

// Monorepo root (../../). Required for Turbopack to find the workspace root
// when next.config.ts lives inside apps/funnel and `next` is hoisted to the
// repo root node_modules. Without this, Turbopack walks up from /src/app and
// errors with "We couldn't find the Next.js package".
//
// Using process.cwd() so this resolves regardless of how the config gets
// compiled (CJS/ESM). `next build` always runs from apps/funnel, so cwd is
// the app dir and ../../ lands at the monorepo root.
const MONOREPO_ROOT = path.resolve(process.cwd(), "../..");

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const isDev = process.env.NODE_ENV === "development";

// ─────────────────────────────────────────────────────────────────────────────
// 3DS RETURN ORIGINS — READ THIS BEFORE YOU DEPLOY.
//
// A redirect-style 3DS challenge renders OUR OWN success/OTO page INSIDE the
// Solidgate form's iframe. `frame-src 'self'` only covers that when the buyer
// is already on the same origin — and apex vs www are DIFFERENT origins. If the
// host the buyer actually browses is missing here, every 3DS-challenged buyer
// lands on a blocked grey iframe AFTER a successful charge. The money is taken,
// the buyer sees nothing, and no test catches it: the Solidgate sandbox keeps
// its simulated challenge on *.charge-auth.com and never exercises this path.
//
// Derived from NEXT_PUBLIC_FUNNEL_URL, apex + www, so there is one place to set
// it. TODO(new product): if your production host differs from that env var
// (custom domain, extra vanity host), add it to the array below.
// ─────────────────────────────────────────────────────────────────────────────
function selfFrameOrigins(): string[] {
  const configured = process.env.NEXT_PUBLIC_FUNNEL_URL;
  if (!configured) return [];
  try {
    const url = new URL(configured);
    const host = url.hostname.replace(/^www\./, "");
    return [`${url.protocol}//${host}`, `${url.protocol}//www.${host}`];
  } catch {
    return [];
  }
}

const cspDirectives = [
  "default-src 'self'",
  // Solidgate: the payment form loads from cdn.charge-auth.com (their
  // white-label CDN) and pulls Google Pay's SDK from pay.google.com when the
  // wallet button is enabled.
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : "'wasm-unsafe-eval'"} https://cdn.charge-auth.com https://applepay.cdn-apple.com https://pay.google.com https://www.googletagmanager.com https://connect.facebook.net https://us.i.posthog.com https://us-assets.i.posthog.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://va.vercel-scripts.com`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // TODO(new product): add any CDN you serve product imagery from (and mirror
  // it in images.remotePatterns below).
  "img-src 'self' data: blob: https://applepay.cdn-apple.com https://www.googletagmanager.com https://www.facebook.com",
  // applepay.cdn-apple.com: the Apple Pay button's SDK loads its label font
  // from Apple's CDN; without it the button renders with a blocked-font error.
  "font-src 'self' data: https://fonts.gstatic.com https://applepay.cdn-apple.com",
  // pay.google.com is already in script-src/frame-src; the Google Pay SDK also
  // XHRs back to it once the wallet button is enabled, so connect-src needs it
  // too or the button loads and then fails on tap. Apple Pay needs no host
  // here. Apple Pay's JS integration host belongs in script/img/frame-src;
  // Solidgate's docs do not require it in connect-src.
  `connect-src 'self'${isDev ? " http://127.0.0.1:55421" : ""} https://*.supabase.co https://connect.facebook.net https://www.facebook.com https://us.i.posthog.com https://us-assets.i.posthog.com https://eu.i.posthog.com https://eu-assets.i.posthog.com https://vitals.vercel-insights.com https://www.google-analytics.com https://*.charge-auth.com https://*.solidgate.com https://pay.google.com`,
  // 3DS: the Solidgate form opens the challenge in a frame chain that reaches
  // *.solidgate.com — a 3DS-challenge card is blocked outright without it.
  // selfFrameOrigins() adds the public apex + www (see the note above it).
  //
  // hooks/js.stripe.com: NOT a Stripe integration — this boilerplate is
  // Solidgate-only. frame-src governs the frame's POST-REDIRECT url too, and
  // the acs.charge-auth.com verify iframe hands a real challenge off to
  // whatever host the ACQUIRER's ACS uses. On at least one Solidgate acquiring
  // route that host is Stripe's hosted 3DS page. Without these entries every
  // challenged buyer got a blocked grey iframe after paying. Keep them unless
  // you have verified your own acquirer's ACS hosts in production — sandbox
  // will not tell you, its simulated challenge stays on *.charge-auth.com.
  [
    "frame-src 'self'",
    ...selfFrameOrigins(),
    "https://*.charge-auth.com",
    "https://*.solidgate.com",
    "https://hooks.stripe.com",
    "https://js.stripe.com",
    "https://applepay.cdn-apple.com",
    "https://pay.google.com",
  ].join(" "),
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // 'none' would also block OUR OWN success_url from rendering inside the
  // Solidgate form's iframe after a redirect-style 3DS flow (ancestor chain:
  // our page → form-v2.charge-auth.com → success page), leaving the buyer on
  // "payment_error" after a successful charge. Allow only self + the PSP.
  "frame-ancestors 'self' https://*.charge-auth.com https://*.solidgate.com",
];

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: cspDirectives.join("; "),
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // No X-Frame-Options: it cannot express the charge-auth allow-list the 3DS
  // return flow needs; CSP frame-ancestors above is the clickjacking control
  // and takes precedence in every browser that supports it.
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // Everything denied by default. TODO(new product): open a capability only
    // if a step actually needs it (e.g. `camera=(self)` for a photo-capture
    // step) — a blanket grant is a real attack surface on a payment page.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "X-DNS-Prefetch-Control",
    value: "on",
  },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: MONOREPO_ROOT,
  },
  // Must match turbopack.root  -  Vercel CLI otherwise auto-injects this to the
  // app dir (apps/funnel), which makes Turbopack think the monorepo root is
  // here and it can't find the hoisted next/package.json.
  outputFileTracingRoot: MONOREPO_ROOT,
  transpilePackages: ["@repo/shared", "@repo/i18n"],
  images: {
    minimumCacheTTL: 31536000,
    // TODO(new product): allowlist the hosts you serve product imagery from,
    // and add the same hosts to the CSP img-src directive above.
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      // The Apple Pay domain-verification file has no extension, so Next serves
      // it as application/octet-stream — and our global nosniff stops the
      // browser from correcting that. Solidgate requires text/plain exactly, or
      // domain verification fails.
      {
        source: "/.well-known/apple-developer-merchantid-domain-association",
        headers: [{ key: "Content-Type", value: "text/plain" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
