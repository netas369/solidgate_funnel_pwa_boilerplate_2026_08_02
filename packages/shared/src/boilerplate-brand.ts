// ─────────────────────────────────────────────────────────────────────────────
// TODO(new product): this is the FIRST file to edit.
//
// Everything below is placeholder. These two objects are the single brand seam
// for both apps: the funnel + PWA root layouts (title/description/OG/Twitter),
// both manifest.ts files, robots.ts, sitemap.ts, the shared login page, the
// welcome email, the OTP request copy and the digital-delivery email.
// Change the values here and the whole surface follows.
// ─────────────────────────────────────────────────────────────────────────────

export const BOILERPLATE_BRAND = {
  name: 'Acme',
  shortName: 'Acme',
  tagline: 'Your product tagline goes here',
  description:
    'One-sentence description of what this product does for the user.',
  funnelDescription:
    'One-sentence description of what this product does for the user.',
  pwaDescription:
    'One-sentence description of what this product does for the user.',
  supportEmail: 'support@example.com',
  funnelUrl: 'https://funnel.example.com',
  pwaUrl: 'https://app.example.com',
  ogLocale: 'en_US',
  twitterHandle: '',
} as const;

export const BOILERPLATE_COPY = {
  homepageEyebrow: 'Product category',
  homepageHeadline: 'Headline goes here',
  homepageBody: 'Body copy goes here.',
} as const;
