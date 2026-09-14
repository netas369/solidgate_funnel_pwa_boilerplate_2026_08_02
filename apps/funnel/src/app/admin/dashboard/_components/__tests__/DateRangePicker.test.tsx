import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DateRangePicker } from '../DateRangePicker';

describe('financial report date range', () => {
  it('allows a single UTC day and sends the following midnight as exclusive end', () => {
    const onApply = vi.fn();
    render(<DateRangePicker initialFrom="2026-09-14" initialTo="2026-09-14" onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' });
  });
  it('rejects reversed dates', () => {
    render(<DateRangePicker initialFrom="2026-09-15" initialTo="2026-09-14" onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});
