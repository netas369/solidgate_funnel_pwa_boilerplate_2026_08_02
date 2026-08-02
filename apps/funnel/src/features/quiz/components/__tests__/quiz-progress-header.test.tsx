import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuizProgressHeader } from '../quiz-progress-header';

// useTranslations('quiz') backs the back-button aria-label via t('ui.back').
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

/**
 * The progress bar is the inner absolutely-positioned div inside the header's
 * track. It carries `style.width` — the value under test.
 */
function getProgressBar(container: HTMLElement): HTMLElement {
  const bars = Array.from(
    container.querySelectorAll<HTMLElement>('div'),
  ).filter((el) => el.style.position === 'absolute' && el.style.width.endsWith('%'));
  if (bars.length !== 1) {
    throw new Error(`expected exactly one progress bar, found ${bars.length}`);
  }
  return bars[0];
}

describe('QuizProgressHeader', () => {
  it('does not render a step/question counter text', () => {
    render(<QuizProgressHeader currentStep={0} totalQuestions={36} onBack={vi.fn()} />);
    expect(screen.queryByText(/step \d+ of \d+/i)).toBeNull();
    expect(screen.queryByText(/question \d+ of \d+/i)).toBeNull();
  });

  it('step 1 of 36 sweeps the fast zone to ~4% (round(1/10 * 40))', () => {
    const { container } = render(
      <QuizProgressHeader currentStep={0} totalQuestions={36} onBack={vi.fn()} />,
    );
    expect(getProgressBar(container).style.width).toBe('4%');
  });

  it('step 10 of 36 reaches 40% — the end of the fast zone', () => {
    const { container } = render(
      <QuizProgressHeader currentStep={9} totalQuestions={36} onBack={vi.fn()} />,
    );
    expect(getProgressBar(container).style.width).toBe('40%');
  });

  it('uses the slower rate after step 10 (step 23 of 36 → 40 + 13/26*60 = 70%)', () => {
    const { container } = render(
      <QuizProgressHeader currentStep={22} totalQuestions={36} onBack={vi.fn()} />,
    );
    expect(getProgressBar(container).style.width).toBe('70%');
  });

  it('reaches 100% at the final step', () => {
    const { container } = render(
      <QuizProgressHeader currentStep={35} totalQuestions={36} onBack={vi.fn()} />,
    );
    expect(getProgressBar(container).style.width).toBe('100%');
  });

  it('stays linear for short quizzes (≤10 steps): step 5 of 8 → 63%', () => {
    const { container } = render(
      <QuizProgressHeader currentStep={4} totalQuestions={8} onBack={vi.fn()} />,
    );
    // round(5 / 8 * 100) = 63
    expect(getProgressBar(container).style.width).toBe('63%');
  });

  it('hides the progress bar when showProgress is false', () => {
    const { container } = render(
      <QuizProgressHeader
        currentStep={0}
        totalQuestions={36}
        onBack={vi.fn()}
        showProgress={false}
      />,
    );
    const bars = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      (el) => el.style.position === 'absolute' && el.style.width.endsWith('%'),
    );
    expect(bars.length).toBe(0);
  });

  it('back button is NOT rendered when currentStep is 0', () => {
    render(<QuizProgressHeader currentStep={0} totalQuestions={36} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'ui.back' })).toBeNull();
  });

  it('back button IS rendered when currentStep > 0', () => {
    render(<QuizProgressHeader currentStep={1} totalQuestions={36} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'ui.back' })).toBeDefined();
  });

  it('showBack prop overrides the currentStep-based default', () => {
    render(
      <QuizProgressHeader currentStep={0} totalQuestions={36} onBack={vi.fn()} showBack />,
    );
    expect(screen.getByRole('button', { name: 'ui.back' })).toBeDefined();
  });

  it('clicking the back button calls onBack handler', () => {
    const onBack = vi.fn();
    render(<QuizProgressHeader currentStep={1} totalQuestions={36} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'ui.back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('dark variant suppresses the progress bar entirely', () => {
    const { container } = render(
      <QuizProgressHeader
        currentStep={5}
        totalQuestions={36}
        onBack={vi.fn()}
        variant="dark"
      />,
    );
    const bars = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      (el) => el.style.position === 'absolute' && el.style.width.endsWith('%'),
    );
    expect(bars.length).toBe(0);
  });
});
