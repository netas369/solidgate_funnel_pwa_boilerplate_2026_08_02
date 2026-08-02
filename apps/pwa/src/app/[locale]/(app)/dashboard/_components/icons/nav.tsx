/**
 * Tab icons for the member area.
 *
 * The {size, filled} prop contract is what BottomNav, MenuDrawer and
 * FirstRunOnboarding depend on — keep it when swapping in product icons.
 * `filled` marks the active tab; these outline icons express it as a heavier
 * stroke rather than a solid fill, so they stay legible at 24px on both
 * surfaces.
 */

type IconProps = { size?: number; filled?: boolean };

function Outline({ size = 24, filled = false, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={filled ? 2 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.75 20v-5.5h4.5V20" />
    </Outline>
  );
}

export function IconLibrary(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4Z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6Z" />
    </Outline>
  );
}

export function IconProfile(props: IconProps) {
  return (
    <Outline {...props}>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.75 20a7.25 7.25 0 0 1 14.5 0" />
    </Outline>
  );
}
