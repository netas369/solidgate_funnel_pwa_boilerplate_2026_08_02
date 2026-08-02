import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ClaimPurchasePrompt } from '../claim-purchase-prompt';

describe('ClaimPurchasePrompt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the claim prompt with save button', () => {
    render(<ClaimPurchasePrompt />);
    expect(screen.getByText('Save my purchase')).toBeDefined();
    expect(screen.getByText(/Save your purchase/)).toBeDefined();
  });

  it('shows loading state when claiming', async () => {
    // Mock fetch to hang
    global.fetch = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    render(<ClaimPurchasePrompt />);
    fireEvent.click(screen.getByText('Save my purchase'));
    expect(screen.getByText('Saving...')).toBeDefined();
  });

  it('shows success state when authLinked is true', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, authLinked: true }),
    });
    // Mock window.location.reload
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });
    render(<ClaimPurchasePrompt />);
    fireEvent.click(screen.getByText('Save my purchase'));
    await waitFor(() => {
      expect(screen.getByText('Purchase saved to your account!')).toBeDefined();
    });
  });

  it('shows error state when authLinked is false', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, authLinked: false }),
    });
    render(<ClaimPurchasePrompt />);
    fireEvent.click(screen.getByText('Save my purchase'));
    await waitFor(() => {
      expect(screen.getByText(/Could not link your purchase/)).toBeDefined();
    });
  });
});
