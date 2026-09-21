import path from "node:path";
import type { NextConfig } from "next";

// Same reason as apps/funnel: Turbopack walks up from /src/app to find the
// workspace root, and `next` is hoisted to the repo root node_modules.
const MONOREPO_ROOT = path.resolve(process.cwd(), "../..");

// This app renders internal reports over first-party data and loads no third
// party at all — no pixels, no PSP, no fonts. The CSP is therefore about as
// tight as a CSP gets, and should stay that way: the reason this dashboard is
// a separate app is to keep the funnel's much larger attack surface away from
// the one screen that displays quiz answers in aggregate.
const cspDirectives = [
  "default-src 'self'",
  // 'unsafe-inline' covers Next's inline bootstrap script. No external hosts.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // Supabase only — the anon key plus the analyst's JWT, calling the cro_* RPCs.
  "connect-src 'self' https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing here should ever be framed.
  //
  // NOTE if you later want PMC Hub to embed this board rather than link to it:
  // this is the line that blocks it, and widening it is a deliberate decision,
  // not a config tweak. An iframe also puts the session cookie in a
  // third-party context, which Safari blocks outright — so a link that opens in
  // a new tab is the cheaper path, and the one this app is built for.
  "frame-ancestors 'none'",
];

const nextConfig: NextConfig = {
  turbopack: {
    root: MONOREPO_ROOT,
  },
  outputFileTracingRoot: MONOREPO_ROOT,
  // No @repo/i18n: this board is English-only and internal.
  transpilePackages: ["@repo/shared"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspDirectives.join("; ") },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // An internal analytics board has no business being indexed, and it
          // is reachable on a public hostname.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
