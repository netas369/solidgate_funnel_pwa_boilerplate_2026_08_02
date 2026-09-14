import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';
import './globals.css';

// Inter fills BOTH slots. apps/funnel pairs it with a serif for display, but a
// serif wordmark over a dense grid of numbers reads as a different product
// rather than as this one. Self-hosted at build time by next/font, which is why
// next.config.ts needs no font-CDN exception in its CSP.
const sans = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-sans-loaded',
  weight: ['400', '500', '600', '700'],
});

const display = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-display-loaded',
  weight: ['500', '600', '700'],
});

export const metadata: Metadata = {
  metadataBase: new URL(BOILERPLATE_BRAND.croUrl),
  title: 'Quiz performance',
  applicationName: BOILERPLATE_BRAND.name,
  // Belt and braces with the X-Robots-Tag header in next.config.ts. This board
  // is internal and must never be indexed.
  robots: { index: false, follow: false },
  // TODO(new product): an OpenGraph block belongs here once you have an OG
  // image. noindex and OG are not in tension — robots governs SEARCH crawlers,
  // while a chat client unfurling a pasted internal link reads the OG tags and
  // ignores robots. Without them the link unfurls as whatever BOILERPLATE_BRAND
  // still says. It has to live on THIS layout rather than the dashboard route,
  // because an unauthenticated fetch lands on /login, which inherits this one.
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
