import withSerwistInit from "@serwist/next";
import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const withSerwist = withSerwistInit({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
});

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/shared", "@repo/i18n"],
  turbopack: {},
  async headers() {
    return [
      // The Apple Pay domain-verification file has no extension, so Next serves
      // it as application/octet-stream. Solidgate requires text/plain exactly,
      // or domain verification fails.
      {
        source: "/.well-known/apple-developer-merchantid-domain-association",
        headers: [{ key: "Content-Type", value: "text/plain" }],
      },
    ];
  },
};

export default withSerwist(withNextIntl(nextConfig));
