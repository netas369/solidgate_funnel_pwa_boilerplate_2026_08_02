'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The section nav, with the current section marked.
 *
 * A client component only because it needs `usePathname` — the layout that
 * renders it is a server component and must stay one, since it is also where
 * the analyst membership re-check lives.
 *
 * The board this is ported from rendered five identically-styled links, so
 * nothing on screen said which section you were looking at; every screen's own
 * `<h2>` had to do that job from further down the page. The accent fill is the
 * funnel's green, matching the active chip on the range and market pickers —
 * one "this is the one you picked" treatment across the whole board rather than
 * a second visual language in the header.
 */
const TABS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/steps', label: 'Drop-off' },
  { href: '/dashboard/live', label: 'Right now' },
  { href: '/dashboard/answers', label: 'Answers' },
  { href: '/dashboard/segments', label: 'Language & device' },
];

export function DashboardTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-1" aria-label="Sections">
      {TABS.map((tab) => {
        // Exact match, not startsWith: '/dashboard' is a prefix of every other
        // tab's href, so a prefix test would light Overview on all five.
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className="rounded-md px-3 py-2 text-sm transition-colors"
            style={
              active
                ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                : { color: 'var(--ink-soft)' }
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
