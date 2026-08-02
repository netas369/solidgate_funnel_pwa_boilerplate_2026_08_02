'use client';

// Shared top nav for the full-bleed quiz screens: back button, an optional
// centre slot, and a spacer that keeps that slot optically centred.
//
// The centre slot is a prop, not a hardcoded logo — pass your mark from the one
// place that knows about branding rather than editing this file.

interface QuizNavProps {
  onBack: () => void;
  backLabel: string;
  /** Optional centre mark (e.g. a logo). Nothing is rendered when omitted. */
  centre?: React.ReactNode;
}

export function QuizNav({ onBack, backLabel, centre }: QuizNavProps) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 12px 4px',
        flex: '0 0 auto',
        position: 'relative',
        zIndex: 3,
      }}
    >
      <style>{`
        .quizNavBackArrow { transform: none; }
        [dir='rtl'] .quizNavBackArrow { transform: rotate(180deg); }
      `}</style>

      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        className="tap"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          borderRadius: 16,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        <svg className="quizNavBackArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M16 7.83333L0.5 7.83333C1.29667 7.83333 2.28667 7.35417 3.10333 6.855C4.1925 6.18917 5.1425 5.31667 5.9375 4.31667C6.55583 3.54167 7.16667 2.61833 7.16667 2M0.5 7.83333C1.29667 7.83333 2.2875 8.3125 3.10333 8.81167C4.1925 9.47833 5.1425 10.3508 5.9375 11.3492C6.55583 12.125 7.16667 13.05 7.16667 13.6667"
            stroke="var(--quiz-accent, #7f4cf2)"
            strokeWidth="1.2"
          />
        </svg>
      </button>

      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 34 }}>
        {centre}
      </span>

      <span style={{ width: 44, height: 44 }} aria-hidden="true" />
    </nav>
  );
}
