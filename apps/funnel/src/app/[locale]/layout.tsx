import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale, getMessages } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocaleDir, routing } from "@repo/i18n/routing";
import "../globals.css";
import { Inter, Source_Serif_4 } from "next/font/google";
import { cn } from "@repo/shared/utils";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";
import { Providers } from "./_components/providers";
import { ImageDragGuard } from "./_components/image-drag-guard";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { GoogleTagManager } from "@next/third-parties/google";
import { MetaPixel } from "@/features/analytics/components/meta-pixel";


// TWO families: one sans for body/UI, one serif for display. globals.css
// aliases the other --font-* variables onto these, so swapping the typefaces
// for your product is a two-line change here.
// TODO(new product): replace with your own pairing.
const sans = Inter({
  subsets: ["latin", "latin-ext", "greek", "cyrillic"],
  variable: "--font-sans-loaded",
  weight: ["400", "500", "600", "700"],
});
const display = Source_Serif_4({
  subsets: ["latin", "latin-ext", "cyrillic", "greek"],
  variable: "--font-display-loaded",
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

// KEEP THIS MECHANISM. A display face usually ships fewer script subsets than
// a UI sans. next/font pairs every family
// with an adjusted LOCAL fallback — e.g. local(Times) at a size-adjust tuned
// for Latin metrics — and that fallback wins for any script the real font does
// not cover. The result is not "a different font": it is the wrong font
// rendered at a scaled-up size, which overflows dvh-locked quiz steps whose
// clamps were tuned for the intended metrics.
//
// So for locales the display face cannot serve, repoint the VARIABLE at the
// sans. One override fixes every consumer (quiz steps, offer, OTO) instead of
// patching each inline font stack.
//
// The shipped display face (Source Serif 4) covers Latin, Cyrillic and Greek,
// so this set is empty. It is NOT dead code: repopulate it the moment you swap
// in a display face with narrower coverage.
// TODO(new product): recompute this list from your own display face's subsets.
const NON_LATIN_SCRIPT_LOCALES = new Set<string>([]);

const SITE_URL =
  process.env.NEXT_PUBLIC_FUNNEL_URL ?? BOILERPLATE_BRAND.funnelUrl;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${BOILERPLATE_BRAND.name}  -  ${BOILERPLATE_BRAND.tagline}`,
    template: `%s  -  ${BOILERPLATE_BRAND.name}`,
  },
  description: BOILERPLATE_BRAND.funnelDescription,
  applicationName: BOILERPLATE_BRAND.name,
  authors: [{ name: BOILERPLATE_BRAND.name, url: SITE_URL }],
  creator: BOILERPLATE_BRAND.name,
  publisher: BOILERPLATE_BRAND.name,
  // TODO(new product): add your search keywords.
  keywords: [],
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/images/favicon/favicon.ico", sizes: "any" },
      {
        url: "/images/favicon/favicon-16x16.png",
        type: "image/png",
        sizes: "16x16",
      },
      {
        url: "/images/favicon/favicon-32x32.png",
        type: "image/png",
        sizes: "32x32",
      },
      {
        url: "/images/favicon/android-chrome-192x192.png",
        type: "image/png",
        sizes: "192x192",
      },
      {
        url: "/images/favicon/android-chrome-512x512.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
    apple: [
      {
        url: "/images/favicon/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
    shortcut: ["/images/favicon/favicon.ico"],
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    siteName: BOILERPLATE_BRAND.name,
    title: `${BOILERPLATE_BRAND.name}  -  ${BOILERPLATE_BRAND.tagline}`,
    description: BOILERPLATE_BRAND.funnelDescription,
    url: SITE_URL,
    locale: BOILERPLATE_BRAND.ogLocale,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: `${BOILERPLATE_BRAND.name}  -  ${BOILERPLATE_BRAND.tagline}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    // Omitted entirely while BOILERPLATE_BRAND.twitterHandle is blank —
    // shipping `site: ""` makes X render an empty attribution.
    ...(BOILERPLATE_BRAND.twitterHandle
      ? {
          site: BOILERPLATE_BRAND.twitterHandle,
          creator: BOILERPLATE_BRAND.twitterHandle,
        }
      : {}),
    title: `${BOILERPLATE_BRAND.name}  -  ${BOILERPLATE_BRAND.tagline}`,
    description: BOILERPLATE_BRAND.funnelDescription,
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport = {
  // Keep in sync with --color-brand in globals.css and theme_color in manifest.ts.
  // TODO(new product): replace with your brand colour.
  themeColor: "#1f2933",
  colorScheme: "light",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  // Validate locale
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();
  const dir = getLocaleDir(locale);
  const scriptFontOverride = NON_LATIN_SCRIPT_LOCALES.has(locale)
    ? ({ "--font-display-loaded": sans.style.fontFamily } as React.CSSProperties)
    : undefined;

  return (
    <html lang={locale} dir={dir} style={scriptFontOverride} className={cn("h-full antialiased", "font-sans", sans.variable, display.variable)}>
      <head>
        {/* Material Symbols is used by the quiz/offer UI. Drop this link (and
            the fonts.googleapis.com / fonts.gstatic.com CSP entries in
            next.config.ts) if your UI ships its own icons. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0"
        />
      </head>
      <body dir={dir} className="min-h-full flex flex-col">
        <NextIntlClientProvider messages={messages}>
          <Providers locale={locale}>
            {children}
            {process.env.NEXT_PUBLIC_GTM_ID && (
              <GoogleTagManager gtmId={process.env.NEXT_PUBLIC_GTM_ID} />
            )}
            <MetaPixel />
            <Analytics />
            <SpeedInsights />
          </Providers>
        </NextIntlClientProvider>
        <ImageDragGuard />
      </body>
    </html>
  );
}
