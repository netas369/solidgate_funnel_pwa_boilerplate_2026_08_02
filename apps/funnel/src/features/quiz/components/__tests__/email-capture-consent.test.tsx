import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailCaptureStep } from '../steps/email-capture-step';
import { EMAIL_CONSENT_VERSION } from '@/features/quiz/config/consent';

// BottomBar portals to document.body; a passthrough keeps the submit button
// inside the same form for the tests.
vi.mock('../steps/_bottom-bar', () => ({
  BottomBar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// English translations for the `quiz` namespace keys EmailCaptureStep reads.
// The marketing/consent strings are the ones the consent tests match on by name.
const translations: Record<string, string> = {
  'phases.account': 'Account',
  'steps.step39.title': 'Placeholder email question goes here',
  'steps.step39.subtext': 'Placeholder supporting line goes here.',
  'steps.step39.privacyNote': 'Placeholder privacy note goes here.',
  'ui.emailLabel': 'Email address',
  'ui.emailPlaceholder': 'you@example.com',
  'ui.validEmail': 'Please enter a valid email address',
  'ui.consentProcessing':
    'I agree to the processing of my email and quiz responses as described in the <link>Privacy Policy</link>.',
  'ui.consentProcessingAria':
    'I agree to the processing of my email and quiz responses as described in the Privacy Policy.',
  'ui.consentMarketing':
    "I'd like to receive tips and offers by email. I can unsubscribe at any time.",
  'ui.dataSecure': 'Your data is encrypted and secure.',
  'ui.submitting': 'Submitting...',
};

const mockT = Object.assign(
  (key: string) => translations[key] ?? key,
  {
    // Minimal rich-text handler: splits a single <tag>…</tag> and feeds the
    // inner chunk through the supplied component fn.
    rich: (
      key: string,
      components?: Record<string, (chunks: React.ReactNode) => React.ReactNode>,
    ) => {
      const text = translations[key] ?? key;
      if (!components) return text;
      const parts: React.ReactNode[] = [];
      let remaining = text;
      for (const [tag, fn] of Object.entries(components)) {
        const open = `<${tag}>`;
        const close = `</${tag}>`;
        const start = remaining.indexOf(open);
        if (start === -1) continue;
        const end = remaining.indexOf(close, start);
        if (end === -1) continue;
        parts.push(remaining.slice(0, start));
        parts.push(fn(remaining.slice(start + open.length, end)));
        remaining = remaining.slice(end + close.length);
      }
      parts.push(remaining);
      return (
        <>
          {parts.map((part, i) => (
            <React.Fragment key={i}>{part}</React.Fragment>
          ))}
        </>
      );
    },
    raw: (key: string) => translations[key] ?? key,
  },
) as unknown as ReturnType<typeof import('next-intl').useTranslations>;

// step.stepId drives the steps.<id>.title / .subtext / .privacyNote keys.
const mockStep = {
  stepId: 'step39',
  phase: 'phases.account',
  type: 'email_capture' as const,
  storeAs: 'email',
  buttonLabel: 'See My Results',
  nextStepId: 'step40',
};

describe('Email Capture Consent UI', () => {
  let mockOnSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnSubmit = vi.fn();
  });

  it('renders the data-processing consent checkbox checked by default (opt-out)', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);
    const checkbox = screen.getByRole('checkbox', { name: /processing of my email/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('does not render a marketing consent checkbox (consent is always granted)', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);
    expect(screen.queryByRole('checkbox', { name: /tips and offers/i })).toBeNull();
  });

  it('privacy policy link has href="/privacy" and target="_blank"', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);
    const link = screen.getByRole('link', { name: /privacy policy/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/privacy');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('submit button is disabled when email is valid but consent is unchecked', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /processing of my email/i }));

    const button = screen.getByRole('button', { name: /see my results/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('submit button is disabled when consent is checked but email is empty', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);
    // consent defaults to checked; email left blank
    const button = screen.getByRole('button', { name: /see my results/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('submit button is enabled when email is valid AND consent is checked', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });

    const button = screen.getByRole('button', { name: /see my results/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('onSubmit is NOT called when the form is submitted without consent', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /processing of my email/i }));

    const form = screen.getByRole('button', { name: /see my results/i }).closest('form')!;
    fireEvent.submit(form);

    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('onSubmit is NOT called and an error shows when the email is invalid', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'not-an-email' },
    });
    const form = screen.getByRole('button', { name: /see my results/i }).closest('form')!;
    fireEvent.submit(form);

    expect(mockOnSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/valid email/i);
  });

  it('onSubmit receives EmailConsentData when consent is checked and form submitted', async () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: /see my results/i }));

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));

    const callArgs = mockOnSubmit.mock.calls[0][0];
    expect(callArgs).toHaveProperty('email', 'test@example.com');
    expect(callArgs).toHaveProperty('consentGivenAt');
    expect(callArgs).toHaveProperty('consentVersion');
    // Marketing consent is always granted — there is no opt-out checkbox.
    expect(callArgs).toHaveProperty('marketingConsent', true);
    expect(() => new Date(callArgs.consentGivenAt).toISOString()).not.toThrow();
  });

  it('trims surrounding whitespace from the submitted email', async () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: '  test@example.com  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /see my results/i }));

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));
    expect(mockOnSubmit.mock.calls[0][0].email).toBe('test@example.com');
  });

  it('re-checking consent re-enables the submit button', () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });

    const consentCheckbox = screen.getByRole('checkbox', { name: /processing of my email/i });
    const button = screen.getByRole('button', { name: /see my results/i });

    fireEvent.click(consentCheckbox);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(consentCheckbox);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('consentVersion in the onSubmit payload equals EMAIL_CONSENT_VERSION', async () => {
    render(<EmailCaptureStep step={mockStep} t={mockT} onSubmit={mockOnSubmit} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });
    // Processing consent defaults to checked.
    fireEvent.click(screen.getByRole('button', { name: /see my results/i }));

    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1));

    const callArgs = mockOnSubmit.mock.calls[0][0];
    expect(callArgs.consentVersion).toBe(EMAIL_CONSENT_VERSION);
    expect(callArgs.consentVersion).toBe('1.0');
    expect(callArgs.marketingConsent).toBe(true);
  });
});
