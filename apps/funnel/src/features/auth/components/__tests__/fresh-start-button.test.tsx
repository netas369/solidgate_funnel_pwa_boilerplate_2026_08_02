import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogoutButton } from '../logout-button';

const {
  quizReset,
  clearQuizStorage,
  clearEvents,
  useQuizStore,
  useFunnelStore,
  useAnalyticsStore,
  assignMock,
  fetchMock,
} = vi.hoisted(() => ({
  quizReset: vi.fn(),
  clearQuizStorage: vi.fn(),
  clearEvents: vi.fn(),
  useQuizStore: {
    getState: vi.fn(),
    persist: {} as { clearStorage?: ReturnType<typeof vi.fn> },
  },
  useFunnelStore: {
    setState: vi.fn(),
  },
  useAnalyticsStore: {
    getState: vi.fn(),
  },
  assignMock: vi.fn(),
  fetchMock: vi.fn(),
}));

useQuizStore.persist.clearStorage = clearQuizStorage;

vi.mock('@/stores/quiz-store', () => ({
  useQuizStore,
}));

vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore,
}));

vi.mock('@/stores/analytics-store', () => ({
  useAnalyticsStore,
}));

describe('LogoutButton', () => {
  beforeEach(() => {
    quizReset.mockReset();
    clearQuizStorage.mockReset();
    clearEvents.mockReset();
    useQuizStore.getState.mockReset();
    useFunnelStore.setState.mockReset();
    useAnalyticsStore.getState.mockReset();
    assignMock.mockReset();
    fetchMock.mockReset();

    useQuizStore.getState.mockReturnValue({ reset: quizReset });
    useAnalyticsStore.getState.mockReturnValue({ clearEvents });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, redirectTo: '/quiz' }),
    });

    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        assign: assignMock,
      },
    });
  });

  it('renders logout copy', () => {
    render(<LogoutButton />);

    expect(screen.getByRole('button', { name: 'Log out' })).toBeDefined();
  });

  it('clears quiz-store, resets funnel stage to landing, clears analytics events, posts to /api/auth/logout, and then window.location.assign(/quiz)', async () => {
    render(<LogoutButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    });
    await waitFor(() => {
      expect(quizReset).toHaveBeenCalledTimes(1);
      expect(clearQuizStorage).toHaveBeenCalledTimes(1);
      expect(useFunnelStore.setState).toHaveBeenCalledWith({ currentStage: 'landing' });
      expect(clearEvents).toHaveBeenCalledTimes(1);
      expect(assignMock).toHaveBeenCalledWith('/');
    });
  });

  it('shows a temporary submitting state while the logout request is in flight and reenables on failure', async () => {
    let resolveFetch: ((value: { ok: boolean; json: () => Promise<{ error: string }> }) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<LogoutButton />);

    const button = screen.getByRole('button', { name: 'Log out' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(true);
    });

    resolveFetch?.({
      ok: false,
      json: async () => ({ error: 'Failed to reset device state' }),
    });

    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });
    expect(assignMock).not.toHaveBeenCalled();
  });
});
