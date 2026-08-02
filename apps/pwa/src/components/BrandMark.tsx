/**
 * Neutral placeholder brand mark.
 *
 * TODO(new product): replace the paths below with the real logo. Keep it as
 * inline SVG using `currentColor` — it is rendered on both the light and dark
 * surface, and an <img> would need two assets plus a theme switch.
 *
 * Lives in src/components (not in the dashboard tree) because the login route
 * renders it too, and the login route is otherwise unrelated to the dashboard.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M8.5 15.5 12 8l3.5 7.5" />
      <path d="M10 13.2h4" />
    </svg>
  );
}
