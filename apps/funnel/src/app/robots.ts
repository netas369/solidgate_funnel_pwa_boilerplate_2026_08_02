import type { MetadataRoute } from "next";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";

export default function robots(): MetadataRoute.Robots {
  const siteUrl =
    process.env.NEXT_PUBLIC_FUNNEL_URL ?? BOILERPLATE_BRAND.funnelUrl;
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/checkout", "/success", "/oto/", "/dashboard"],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
