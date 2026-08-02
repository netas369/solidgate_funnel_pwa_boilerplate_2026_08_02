import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StepTransition } from '../step-transition';

// Mock motion/react: AnimatePresence renders children, motion.div renders a plain div
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) => {
      const {
        initial: _i,
        animate: _a,
        exit: _e,
        transition: _t,
        ...validProps
      } = props;
      return (
        <div
          data-testid="step-transition-wrapper"
          {...(validProps as React.HTMLAttributes<HTMLDivElement>)}
        >
          {children}
        </div>
      );
    },
  },
  useReducedMotion: () => false,
}));

describe('StepTransition', () => {
  it('renders children content', () => {
    render(
      <StepTransition questionId="q1" direction="forward">
        <p>Hello question</p>
      </StepTransition>
    );
    expect(screen.getByText('Hello question')).toBeDefined();
  });

  it('renders wrapper div with data-testid', () => {
    render(
      <StepTransition questionId="q1" direction="forward">
        <p>Content</p>
      </StepTransition>
    );
    expect(screen.getByTestId('step-transition-wrapper')).toBeDefined();
  });

  it('renders without crashing for forward direction', () => {
    const { container } = render(
      <StepTransition questionId="q1" direction="forward">
        <p>Forward</p>
      </StepTransition>
    );
    expect(container.querySelector('.overflow-hidden')).not.toBeNull();
  });

  it('renders without crashing for backward direction', () => {
    const { container } = render(
      <StepTransition questionId="q2" direction="backward">
        <p>Backward</p>
      </StepTransition>
    );
    expect(container.querySelector('.overflow-hidden')).not.toBeNull();
  });

  it('re-renders children when questionId changes', () => {
    const { rerender } = render(
      <StepTransition questionId="q1" direction="forward">
        <p>Question 1</p>
      </StepTransition>
    );
    expect(screen.getByText('Question 1')).toBeDefined();

    rerender(
      <StepTransition questionId="q2" direction="forward">
        <p>Question 2</p>
      </StepTransition>
    );
    expect(screen.getByText('Question 2')).toBeDefined();
  });
});
