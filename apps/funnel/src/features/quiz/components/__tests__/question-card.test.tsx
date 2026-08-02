import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RadioStep } from '../steps/radio-step';
import type { RadioStep as RadioStepType } from '@/features/quiz/config/quiz-schema';

// ─── Mock the quiz store — RadioStep reads `answers` to resolve {{tokens}} ────
vi.mock('@/stores/quiz-store', () => {
  const state = { answers: {} as Record<string, unknown> };
  return {
    useQuizStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const singleStep: RadioStepType = {
  stepId: 'test_step',
  phase: 'Phase 1',
  type: 'radio',
  storeAs: 'primaryGoal',
  question: 'What is your primary goal?',
  options: [
    { label: 'Boost my self-esteem', value: 'self-esteem', nextStepId: 'next-step' },
    { label: 'Feel lighter & healthier', value: 'health', nextStepId: 'next-step' },
    { label: 'Look great for an event', value: 'event', nextStepId: 'next-step' },
  ],
};

// Passthrough mock: step data already contains display-ready English strings.
// RadioStep calls both `t(key)` and `t.raw(key)`, so the mock needs both.
const mockT = Object.assign((key: string) => key, {
  raw: (key: string) => key,
}) as unknown as ReturnType<typeof import('next-intl').useTranslations>;

describe('RadioStep', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders the question text in an h2 element', () => {
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={vi.fn()} />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('What is your primary goal?');
  });

  it('renders one option per entry as a radio button', () => {
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(3);
  });

  it('renders all options inside a labelled radiogroup', () => {
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={vi.fn()} />);
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBe('step-test_step');
  });

  it('marks the selected option as checked', () => {
    render(<RadioStep step={singleStep} t={mockT} selectedValue="health" onSelect={vi.fn()} />);
    const checked = screen
      .getAllByRole('radio')
      .filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked.length).toBe(1);
    expect(checked[0].textContent).toContain('Feel lighter & healthier');
  });

  it('auto-advances 200ms after a click, calling onSelect with (nextStepId, storeAs, value, label)', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={onSelect} />);

    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[1]); // "health"

    // No immediate fire — the 200ms debounce lets the selection state animate first.
    expect(onSelect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      'next-step',
      'primaryGoal',
      'health',
      'Feel lighter & healthier',
    );
  });

  it('does not fire onSelect before the 200ms timer elapses', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={onSelect} />);

    fireEvent.click(screen.getAllByRole('radio')[0]);
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the just-clicked option as checked immediately (pending state)', () => {
    vi.useFakeTimers();
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={vi.fn()} />);

    const radios = screen.getAllByRole('radio');
    act(() => {
      fireEvent.click(radios[2]); // "event"
    });
    expect(radios[2].getAttribute('aria-checked')).toBe('true');
  });

  it('does not render a Continue button', () => {
    render(<RadioStep step={singleStep} t={mockT} selectedValue={undefined} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
  });
});
