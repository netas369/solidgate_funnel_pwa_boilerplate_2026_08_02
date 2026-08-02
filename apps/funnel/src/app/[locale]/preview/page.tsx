import { Link } from '@repo/i18n/navigation';
import { OTO_CONFIG, OTO_STEPS } from '@/features/oto/config/oto-config';

// The OTO link list is GENERATED from OTO_CONFIG so it can never drift from
// the routes. `href` values are locale-stripped paths — next-intl's <Link>
// re-adds the active locale prefix, so language survives navigation.
const GROUPS: { title: string; links: { href: string; label: string; note?: string }[] }[] = [
  {
    title: 'Offer',
    links: [
      { href: '/preview/offer', label: 'Offer  -  price picker', note: '/offer' },
      { href: '/preview/offer/details', label: 'Offer  -  sales body + checkout', note: '/offer/details' },
      { href: '/preview/special-offer', label: 'Special offer', note: '/special-offer' },
      { href: '/preview/special-offer-free', label: 'Special offer (free trial)', note: '/special-offer-free' },
    ],
  },
  {
    title: 'One-time offers (OTO)',
    links: [
      ...OTO_STEPS.map((step) => ({
        href: `/preview/oto/${step}`,
        label: `OTO ${step}  -  ${OTO_CONFIG[step].options.length > 1 ? 'choose one' : 'single product'}`,
        note: `/oto/${step}`,
      })),
      { href: '/preview/oto/8', label: 'OTO 8  -  summary + app handoff', note: '/oto/8' },
    ],
  },
];

export default function PreviewIndexPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#faf8f4',
        color: '#111',
        padding: '48px 22px 120px',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid #111',
            borderRadius: 999,
            padding: '6px 12px',
            fontSize: 11,
            letterSpacing: '0.18em',
            fontFamily: 'ui-monospace, Menlo, monospace',
            marginBottom: 20,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 999, background: '#f5b301' }} />
          PREVIEW MODE
        </div>

        <h1 style={{ fontSize: 30, lineHeight: 1.15, margin: '0 0 10px' }}>Page previews</h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.7, margin: '0 0 32px', maxWidth: 560 }}>
          Read-only copies of the offer and OTO pages for UI review. No quiz, no
          payment, no analytics  -  the &ldquo;Continue&rdquo; / &ldquo;Buy&rdquo; / &ldquo;Skip&rdquo; buttons just walk
          you to the next preview page. Use the floating control (bottom-right) to
          switch language on any page.
        </p>

        {GROUPS.map((group) => (
          <section key={group.title} style={{ marginBottom: 30 }}>
            <h2
              style={{
                fontSize: 12,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                opacity: 0.55,
                margin: '0 0 12px',
                fontFamily: 'ui-monospace, Menlo, monospace',
              }}
            >
              {group.title}
            </h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    background: '#fff',
                    border: '1px solid #e6e1d8',
                    borderRadius: 12,
                    padding: '16px 18px',
                    textDecoration: 'none',
                    color: '#111',
                  }}
                >
                  <span style={{ fontSize: 16, fontWeight: 500 }}>{link.label}</span>
                  {link.note && (
                    <span
                      style={{
                        fontSize: 12,
                        opacity: 0.5,
                        fontFamily: 'ui-monospace, Menlo, monospace',
                      }}
                    >
                      {link.note}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
