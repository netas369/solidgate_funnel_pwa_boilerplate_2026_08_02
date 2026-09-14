import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Warnings } from './Warnings';

afterEach(cleanup);

describe('Warnings', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<Warnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the command for an unpublished catalog', () => {
    // The state every new product starts in. Without the advice line the
    // analyst is told what is wrong and not what to do about it.
    render(
      <Warnings warnings={[{ code: 'CATALOG_NOT_PUBLISHED', message: 'No definition.' }]} />,
    );
    expect(screen.getByText('No definition.')).toBeInTheDocument();
    expect(screen.getByText(/publish-quiz-definition\.ts --apply/)).toBeInTheDocument();
  });

  it('shows a warning it has no advice for, rather than swallowing it', () => {
    render(<Warnings warnings={[{ code: 'SOMETHING_NEW', message: 'Unexpected.' }]} />);
    expect(screen.getByText('Unexpected.')).toBeInTheDocument();
  });

  it('announces itself, so it is not silent to a screen reader above the data', () => {
    render(<Warnings warnings={[{ code: 'SMALL_SAMPLE', message: 'Only 4 people.' }]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Only 4 people.');
  });

  it('renders every warning, not just the first', () => {
    render(
      <Warnings
        warnings={[
          { code: 'SMALL_SAMPLE', message: 'Only 4 people.' },
          { code: 'RETIRED_STEPS', message: 'Some steps are gone.' },
        ]}
      />,
    );
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });
});
