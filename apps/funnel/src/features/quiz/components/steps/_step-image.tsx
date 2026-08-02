'use client';

/**
 * Decorative image slot with a built-in placeholder.
 *
 * The boilerplate ships no raster art, and every `image` field in the quiz
 * schema is optional, so step renderers must degrade to something that still
 * reads as intentional. `StepImage` draws the real asset when a `src` is given
 * and a neutral gradient block with a dashed edge when it is not — same box,
 * same layout, no broken-image icon and no 404.
 *
 * All uses are decorative (`aria-hidden`); the meaningful copy always lives in
 * the surrounding text, so there is nothing to announce.
 */
export function StepImage({
  src,
  style,
  className,
  radius,
}: {
  src?: string;
  style?: React.CSSProperties;
  className?: string;
  /** Convenience shorthand; merged into `style.borderRadius`. */
  radius?: number | string;
}) {
  const merged: React.CSSProperties = radius !== undefined ? { borderRadius: radius, ...style } : { ...style };

  if (src) {
    return <img src={src} alt="" aria-hidden="true" className={className} style={merged} />;
  }

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        ...merged,
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.05) 50%, rgba(0,0,0,0.10) 100%)',
        border: '1px dashed rgba(255,255,255,0.28)',
        boxSizing: 'border-box',
      }}
    />
  );
}
