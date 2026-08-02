'use client';

import { useTranslations } from 'next-intl';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

type HeaderVariant = 'light' | 'dark';

interface QuizProgressHeaderProps {
  currentStep: number;
  totalQuestions: number;
  onBack: () => void;
  showBack?: boolean;
  showProgress?: boolean;
  phaseName?: string;
  variant?: HeaderVariant;
  /**
   * Brand mark shown in place of the back button on the first step. Defaults to
   * a neutral placeholder square — pass your own logo node here rather than
   * editing this component.
   */
  logo?: React.ReactNode;
}

// Neutral stand-in for a product logo: a plain rounded square in the current
// ink colour. Replace by passing `logo` rather than editing this file.
function PlaceholderMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="2" fill="currentColor" />
    </svg>
  );
}

// The progress bar is intentionally non-linear. The first 10 questions sweep the
// bar to 40% so the quiz feels like it's moving quickly early — keeping people
// from dropping off without overselling how close they are. The rest fill the
// remaining 60% at a calmer pace.
const FAST_ZONE_STEPS = 10;
const FAST_ZONE_TARGET = 40;

function computeProgressPercent(stepNumber: number, totalQuestions: number): number {
  const total = Math.max(1, totalQuestions);
  const step = Math.min(Math.max(stepNumber, 0), total);

  // Short quizzes have nothing to disguise — keep it linear.
  if (total <= FAST_ZONE_STEPS) {
    return Math.min(100, Math.round((step / total) * 100));
  }

  // Fast zone: first 10 questions race to 40%.
  if (step <= FAST_ZONE_STEPS) {
    return Math.round((step / FAST_ZONE_STEPS) * FAST_ZONE_TARGET);
  }

  // Slow zone: remaining questions split the last 60%.
  const slowProgress = (step - FAST_ZONE_STEPS) / (total - FAST_ZONE_STEPS);
  return Math.min(100, Math.round(FAST_ZONE_TARGET + slowProgress * (100 - FAST_ZONE_TARGET)));
}

export function QuizProgressHeader({
  currentStep,
  totalQuestions,
  onBack,
  showBack,
  showProgress = true,
  phaseName,
  variant = 'light',
  logo,
}: QuizProgressHeaderProps) {
  const t = useTranslations('quiz');
  const isBackVisible = showBack !== undefined ? showBack : currentStep > 0;
  const stepNumber = currentStep + 1;
  const progressPercent = computeProgressPercent(stepNumber, totalQuestions);
  const isDark = variant === 'dark';

  // The dark variant hides chrome that creates a "N steps ahead" psychological
  // wall on the very first impression: step counter, progress bar and phase
  // label are all suppressed.
  const showStepChrome = !isDark;

  const headerStyle: React.CSSProperties = isDark
    ? {
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background:
          'linear-gradient(180deg, rgba(11, 10, 31, 0.92) 0%, rgba(11, 10, 31, 0.55) 70%, rgba(11, 10, 31, 0) 100%)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderBottom: '1px solid rgba(212, 165, 92, 0.14)',
        color: '#f5ede0',
      }
    : {
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'var(--paper)',
        borderBottom: '1px solid var(--ink)',
        color: 'var(--ink)',
      };

  return (
    <header style={headerStyle}>
      <div
        style={{
          maxWidth: 820,
          margin: '0 auto',
          padding: 'calc(14px + env(safe-area-inset-top)) 22px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        {isBackVisible ? (
          <button
            type="button"
            aria-label={t('ui.back')}
            onClick={onBack}
            className="tap mono-up"
            style={{
              background: 'transparent',
              color: isDark ? '#f5ede0' : 'var(--ink)',
              border: `1px solid ${isDark ? 'rgba(245, 237, 224, 0.35)' : 'var(--ink)'}`,
              padding: '7px 11px',
              fontSize: 9,
              letterSpacing: '0.18em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span aria-hidden>←</span>
            {t('ui.back')}
          </button>
        ) : (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            {logo ?? <PlaceholderMark size={20} />}
            <span className="serif" style={{ fontSize: 21, fontWeight: 600, lineHeight: 1 }}>
              {BOILERPLATE_BRAND.name}
            </span>
          </div>
        )}

        {showStepChrome && (
          <div className="serif-it" style={{ fontSize: 14, opacity: 0.55 }}>
            {phaseName ?? ''}
          </div>
        )}

        {/* Right-side spacer keeps the phase label centred now that the locale
            switcher is gone — visitors are already routed to the right locale. */}
        <div aria-hidden style={{ width: 20 }} />
      </div>

      {showProgress && !isDark && (
        <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 22px 14px' }}>
          <div style={{ height: 1, background: 'var(--hairline)', position: 'relative', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${progressPercent}%`,
                background: 'var(--ink)',
                transition: 'width .35s cubic-bezier(.5,.05,.2,1)',
              }}
            />
          </div>
        </div>
      )}
    </header>
  );
}
