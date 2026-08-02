import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import { resolveGenderTokens } from '../templated-text';

// Regression guard: next-intl parses `<g>…</g>` as a rich-text TAG. Plain t()
// throws on the unhandled tag and falls back to the namespaced key, which is
// why gendered offer strings must be read with t.raw() and then passed through
// resolveGenderTokens — never plain t(). This test pins that behaviour so a
// future refactor back to t() fails loudly instead of silently showing keys.
// A synthetic fixture, not product copy. The Lithuanian pair is deliberate:
// the masculine and feminine forms differ, which is the whole reason the <g>
// token exists.
const messages = {
  offer: {
    demo: {
      gendered: { label: '<g>Slenksčio sargas|Slenksčio sargė</g>' },
    },
  },
};

describe('next-intl + <g> gender token', () => {
  it('t.raw returns the raw <g> string (then resolveGenderTokens picks the form)', () => {
    const t = createTranslator({ locale: 'lt', messages, namespace: 'offer' });
    const raw = t.raw('demo.gendered.label') as string;
    expect(raw).toBe('<g>Slenksčio sargas|Slenksčio sargė</g>');
    expect(resolveGenderTokens(raw, 'female')).toBe('Slenksčio sargė');
    expect(resolveGenderTokens(raw, 'male')).toBe('Slenksčio sargas');
  });

  it('plain t() does NOT return usable text for a <g> message (proves why t.raw is required)', () => {
    const t = createTranslator({
      locale: 'lt',
      messages,
      namespace: 'offer',
      onError: () => {}, // swallow the expected MISSING/parse error
    });
    const viaT = t('demo.gendered.label');
    // next-intl falls back to the key (or otherwise fails to yield the real
    // string) — the point is it is NOT the resolved gendered name.
    expect(viaT).not.toBe('Slenksčio sargas');
    expect(viaT).not.toBe('Slenksčio sargė');
  });
});
