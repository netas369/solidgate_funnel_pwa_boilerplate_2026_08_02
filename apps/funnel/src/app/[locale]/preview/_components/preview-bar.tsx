'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, Link } from '@repo/i18n/navigation';
import { useLocale } from 'next-intl';
import { routing } from '@repo/i18n/routing';
import type { Locale } from '@repo/i18n/routing';

// Human-readable language names for the preview switcher. Falls back to the
// uppercased locale code for any locale not listed here.
const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  cs: 'Čeština',
  hu: 'Magyar',
  sk: 'Slovenčina',
  ro: 'Română',
  lt: 'Lietuvių',
  ru: 'Русский',
  lv: 'Latviešu',
  'zh-TW': '繁體中文',
  el: 'Ελληνικά',
  he: 'עברית',
  pl: 'Polski',
  hr: 'Hrvatski',
  da: 'Dansk',
};

/**
 * Preview-only floating control rendered on every /preview/* page.
 *
 * It does two things and nothing else:
 *   1. Marks the page clearly as a PREVIEW (so it is never mistaken for the
 *      live funnel).
 *   2. Provides a language switcher + a link back to the preview index, so a
 *      reviewer can change locale and jump between pages WITHOUT a quiz session.
 *
 * It does not touch any quiz/purchase state. The locale switch reuses the same
 * mechanism as the real nav's LocaleSwitcher: replace the current (locale-
 * stripped) pathname with a new locale, which keeps the /preview/... path.
 */
export function PreviewBar() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pick = (next: Locale) => {
    setOpen(false);
    if (next === locale) return;
    router.replace(pathname, { locale: next });
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    >
      <Link
        href="/preview"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: '#111',
          color: '#fff',
          border: '1px solid #111',
          borderRadius: 999,
          padding: '8px 12px',
          fontSize: 11,
          letterSpacing: '0.14em',
          textDecoration: 'none',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            borderRadius: 999,
            background: '#f5b301',
          }}
        />
        PREVIEW · ALL
      </Link>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: '#fff',
            color: '#111',
            border: '1px solid #111',
            borderRadius: 999,
            padding: '8px 12px',
            fontSize: 11,
            letterSpacing: '0.12em',
            cursor: 'pointer',
          }}
        >
          🌐 {locale.toUpperCase()}
          <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
            ▾
          </span>
        </button>

        {open && (
          <div
            role="menu"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 'calc(100% + 8px)',
              minWidth: 200,
              maxHeight: 320,
              overflowY: 'auto',
              background: '#fff',
              border: '1px solid #111',
              borderRadius: 8,
              boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
            }}
          >
            {(routing.locales as readonly Locale[]).map((code) => {
              const active = code === locale;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => pick(code)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    background: active ? '#111' : '#fff',
                    color: active ? '#fff' : '#111',
                    border: 'none',
                    borderBottom: '1px solid #eee',
                    padding: '10px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span>{LOCALE_LABELS[code] ?? code}</span>
                  <span style={{ opacity: 0.6, fontSize: 10 }}>{code.toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
