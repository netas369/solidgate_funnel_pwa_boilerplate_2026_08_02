import { describe, expect, it } from 'vitest';
import { routing } from '@repo/i18n/routing';
import {
  buildOto3PdfEmailHtml,
  getOto3PdfEmailSubject,
} from '../email/oto3-pdf-email';

const PRODUCT_LABEL = 'Test Pack';
const OTO_PDF_SCENARIOS = [
  {
    id: 'oto3_bundle_all',
    label: 'Bundle (all)',
    downloads: ['Report A', 'Report B', 'Report C'],
  },
  {
    id: 'oto3_bundle_1',
    label: 'Bundle 1',
    downloads: ['Report A'],
  },
  {
    id: 'oto3_bundle_2',
    label: 'Bundle 2',
    downloads: ['Report B'],
  },
  {
    id: 'oto3_bundle_3',
    label: 'Bundle 3',
    downloads: ['Report C'],
  },
  {
    id: 'oto4_pdf',
    label: 'Digital Product 4',
    downloads: ['Digital Product 4'],
  },
  {
    id: 'oto5_pdf',
    label: 'Digital Product 5',
    downloads: ['Digital Product 5'],
  },
  {
    id: 'oto6_pdf',
    label: 'Digital Product 6',
    downloads: ['Digital Product 6'],
  },
  {
    id: 'oto7_pdf',
    label: 'Digital Product 7',
    downloads: ['Digital Product 7'],
  },
];

describe('OTO PDF delivery email localization', () => {
  it('covers all routing locales with non-empty subject and html', () => {
    for (const locale of routing.locales) {
      const subject = getOto3PdfEmailSubject(PRODUCT_LABEL, locale);
      const html = buildOto3PdfEmailHtml({
        email: 'buyer@example.com',
        locale,
        productLabel: PRODUCT_LABEL,
        downloads: [{ title: 'Guide PDF', url: 'https://example.com/guide.pdf' }],
      });

      expect(subject.trim(), `${locale}.subject`).not.toBe('');
      expect(subject, `${locale}.subject label`).toContain(PRODUCT_LABEL);
      expect(html.trim(), `${locale}.html`).not.toBe('');
      expect(html, `${locale}.html label`).toContain(PRODUCT_LABEL);
    }
  });

  it('does not alias non-English locales back to English copy', () => {
    const englishSubject = getOto3PdfEmailSubject(PRODUCT_LABEL, 'en');

    for (const locale of routing.locales.filter((item) => item !== 'en')) {
      const subject = getOto3PdfEmailSubject(PRODUCT_LABEL, locale);
      const html = buildOto3PdfEmailHtml({
        email: 'buyer@example.com',
        locale,
        productLabel: PRODUCT_LABEL,
        downloads: [{ title: 'Guide PDF', url: 'https://example.com/guide.pdf' }],
      });

      expect(subject, `${locale}.subject`).not.toBe(englishSubject);
      expect(html, `${locale}.greeting`).not.toContain(
        'Thank you for your purchase. Tap the button under each title to download your PDF.',
      );
      expect(html, `${locale}.expiry`).not.toContain(
        'Save the files to your device  -  these download links never expire.',
      );
      expect(html, `${locale}.footer`).not.toContain(
        'Need help? Reply to this email or write to',
      );
    }
  });

  it('uses RTL document direction for Hebrew', () => {
    const html = buildOto3PdfEmailHtml({
      email: 'buyer@example.com',
      locale: 'he',
      productLabel: PRODUCT_LABEL,
      downloads: [{ title: 'Guide PDF', url: 'https://example.com/guide.pdf' }],
    });

    expect(html).toContain('dir="rtl"');
  });

  it('renders every OTO3-7 PDF email scenario for every locale without syntax leftovers', () => {
    for (const locale of routing.locales) {
      for (const scenario of OTO_PDF_SCENARIOS) {
        const subject = getOto3PdfEmailSubject(scenario.label, locale);
        const html = buildOto3PdfEmailHtml({
          email: 'buyer@example.com',
          locale,
          productLabel: scenario.label,
          downloads: scenario.downloads.map((title, index) => ({
            title,
            url: `https://example.com/${scenario.id}-${index}.pdf?sig=a&x=1`,
          })),
        });

        expect(subject, `${locale}/${scenario.id}.subject`).toContain(scenario.label);
        expect(subject, `${locale}/${scenario.id}.subject placeholders`).not.toMatch(/[{}]/);
        expect(html, `${locale}/${scenario.id}.html label`).toContain(scenario.label);
        expect(html, `${locale}/${scenario.id}.html label placeholder`).not.toContain('{label}');
        expect(html, `${locale}/${scenario.id}.html support placeholder`).not.toContain('{support}');
        expect(html, `${locale}/${scenario.id}.html undefined`).not.toContain('undefined');
        expect(html, `${locale}/${scenario.id}.html ampersand escaped`).toContain('&amp;');

        if (locale === 'he') {
          expect(html, `${locale}/${scenario.id}.rtl html`).toContain('<html lang="he" dir="rtl">');
          expect(html, `${locale}/${scenario.id}.rtl body`).toContain('<body dir="rtl"');
        } else {
          expect(html, `${locale}/${scenario.id}.ltr html`).toContain(`dir="ltr"`);
        }
      }
    }
  });
});
