import type { MetadataRoute } from "next";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BOILERPLATE_BRAND.name,
    short_name: BOILERPLATE_BRAND.shortName,
    description: BOILERPLATE_BRAND.description,
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Must match the --paper value of the member-area dark surface in
    // dashboard/_components/theme.css, or the PWA splash screen flashes a
    // different colour than the app it is about to show.
    background_color: "#131519",
    theme_color: "#131519",
    lang: "en",
    // TODO(new product): set real categories (see the W3C manifest registry).
    categories: ["productivity"],
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
