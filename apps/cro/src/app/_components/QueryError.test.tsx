import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NotAnAnalystError } from '@/lib/queries';
import { QueryError } from './QueryError';

afterEach(cleanup);

describe('QueryError', () => {
  it('tells a non-analyst their sign-in worked', () => {
    // The distinction that matters: without it, revoked access looks exactly
    // like a quiet week.
    render(<QueryError error={new NotAnAnalystError()} />);
    expect(screen.getByText(/do not have access yet/i)).toBeInTheDocument();
    expect(screen.getByText(/sign-in worked/i)).toBeInTheDocument();
  });

  it('recognises the error after it loses its prototype', () => {
    // What actually arrives when the error crosses a server-component
    // boundary: the name survives, `instanceof` does not.
    const flattened = new Error('Your account is not on the CRO analyst list.');
    flattened.name = 'NotAnAnalystError';
    render(<QueryError error={flattened} />);
    expect(screen.getByText(/do not have access yet/i)).toBeInTheDocument();
  });

  it('shows a real failure as a failure, with its message for whoever is debugging', () => {
    render(<QueryError error={new Error('[cro/step-funnel] connection refused')} />);
    expect(screen.getByText(/did not load/i)).toBeInTheDocument();
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
  });

  it('survives something thrown that is not an Error at all', () => {
    render(<QueryError error="nope" />);
    expect(screen.getByText(/did not load/i)).toBeInTheDocument();
  });
});
