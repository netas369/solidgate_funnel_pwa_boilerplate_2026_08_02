/**
 * Minimal root layout required by Next.js App Router.
 * All providers, fonts, and styling live in [locale]/layout.tsx.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
