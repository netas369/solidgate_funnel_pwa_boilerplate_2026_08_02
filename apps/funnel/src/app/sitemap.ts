import type { MetadataRoute } from "next";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";
import { routing, localePathSegment } from "@repo/i18n/routing";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl =
    process.env.NEXT_PUBLIC_FUNNEL_URL ?? BOILERPLATE_BRAND.funnelUrl;
  const now = new Date();

  const publicPaths = [
    "",
    "/quiz",
    "/offer",
    "/privacy",
    "/terms",
    "/cookies",
    "/contact",
    "/subscription",
    "/money-back",
  ];

  // Locale SEGMENT, not identifier. Interpolating `/${locale}` published 54
  // hard 404s across the six country-code locales (cs→/cz, da→/dk, zh-TW→/tw,
  // el→/gr, he→/il, ja→/jp) and pointed every `en` entry at a 307 redirect
  // rather than the canonical unprefixed URL.
  return publicPaths.flatMap((path) =>
    routing.locales.map((locale) => ({
      url: `${siteUrl}${localePathSegment(locale)}${path}`,
      lastModified: now,
      changeFrequency: path === "" ? ("weekly" as const) : ("monthly" as const),
      priority: path === "" ? 1 : 0.6,
    })),
  );
}
