import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { getLocaleDir, routing } from "@repo/i18n/routing";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";
import "../globals.css";

// One self-hosted variable font for the whole app. next/font inlines it, so
// there is no render-blocking request to a third-party font CDN (which would
// also need a GDPR note in most of Europe).
//
// TODO(new product): swap for the brand face. If the product ships a CJK or
// RTL locale, add a second next/font here and expose it as --font-cjk.
const sans = Inter({
  subsets: ["latin", "latin-ext", "greek", "cyrillic"],
  variable: "--font-family-sans",
  display: "swap",
});

const SITE_URL =
  process.env.NEXT_PUBLIC_PWA_URL ?? BOILERPLATE_BRAND.pwaUrl;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${BOILERPLATE_BRAND.name}  -  Member Area`,
    template: `%s  -  ${BOILERPLATE_BRAND.name}`,
  },
  description: BOILERPLATE_BRAND.description,
  applicationName: BOILERPLATE_BRAND.name,
  manifest: "/manifest.webmanifest",
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
  appleWebApp: {
    capable: true,
    title: BOILERPLATE_BRAND.name,
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    siteName: BOILERPLATE_BRAND.name,
    title: `${BOILERPLATE_BRAND.name}  -  Member Area`,
    description: BOILERPLATE_BRAND.description,
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
    title: `${BOILERPLATE_BRAND.name}  -  Member Area`,
    description: BOILERPLATE_BRAND.description,
    images: ["/og-image.png"],
  },
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#131519",
  width: "device-width",
  initialScale: 1,
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const messages = await getMessages();
  const dir = getLocaleDir(locale);

  return (
    <html lang={locale} dir={dir} className={sans.variable}>
      <body dir={dir} className="font-sans antialiased">
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
