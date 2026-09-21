import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

/**
 * The wordmark, then the name of this dashboard under it.
 *
 * Text, not a glyph — the same treatment the marketing site uses. The landing
 * nav renders `BOILERPLATE_BRAND.name` with no mark beside it by an explicit
 * decision recorded in LandingNav.tsx ("A mark next to it read as clutter at
 * nav scale"), and the type treatment below mirrors `.lmNavBrand` in
 * landing.css: 22px, weight 700, -0.01em tracking, on --ink.
 *
 * Reading the name from @repo/shared/boilerplate-brand rather than hardcoding
 * "GLP-1 Diet" matters: that constant is the single brand seam for both apps'
 * metadata, manifests, emails and login screens — and it feeds the Apple Pay
 * sheet. A rename there should carry here too, not leave one internal tool
 * showing the old name.
 */
export function BrandMark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const large = size === 'lg';

  return (
    <div className="min-w-0">
      <div
        className="font-bold leading-none text-ink"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: large ? 26 : 22,
          letterSpacing: '-0.01em',
        }}
      >
        {BOILERPLATE_BRAND.name}
      </div>
      <div
        className="mt-2 leading-none text-ink-soft"
        style={{ fontSize: large ? 15 : 13 }}
      >
        Quiz performance
      </div>
    </div>
  );
}
