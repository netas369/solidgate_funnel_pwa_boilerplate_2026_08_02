import type { MetadataRoute } from "next";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BOILERPLATE_BRAND.name,
    short_name: BOILERPLATE_BRAND.shortName,
    description: BOILERPLATE_BRAND.funnelDescription,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Keep in sync with globals.css (--color-surface / --color-brand) and the
    // viewport.themeColor in [locale]/layout.tsx.
    // TODO(new product): replace with your brand colours.
    background_color: "#ffffff",
    theme_color: "#1f2933",
    lang: "en",
    // TODO(new product): pick the categories that match your app.
    // https://github.com/w3c/manifest/wiki/Categories
    categories: ["lifestyle"],
    icons: [
      {
        src: "/images/favicon/favicon-16x16.png",
        sizes: "16x16",
        type: "image/png",
      },
      {
        src: "/images/favicon/favicon-32x32.png",
        sizes: "32x32",
        type: "image/png",
      },
      {
        src: "/images/favicon/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
      {
        src: "/images/favicon/android-chrome-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/images/favicon/android-chrome-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
