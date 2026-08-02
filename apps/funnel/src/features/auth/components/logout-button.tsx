'use client';

import { useState } from 'react';
import { useAnalyticsStore } from '@/stores/analytics-store';
import { useFunnelStore } from '@/stores/funnel-store';
import { useQuizStore } from '@/stores/quiz-store';
import { resetPostHogIdentity } from '@/features/analytics/lib/posthog';
import { cn } from '@repo/shared/utils';

interface LogoutButtonProps {
  className?: string;
}

export function LogoutButton({ className }: LogoutButtonProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleClick() {
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });

      if (!response.ok) {
        throw new Error('Failed to log out');
      }

      await response.json();
      resetPostHogIdentity();
      useQuizStore.getState().reset();
      useQuizStore.persist?.clearStorage?.();
      useFunnelStore.setState({ currentStage: 'landing' });
      useAnalyticsStore.getState().clearEvents();
      window.location.assign('/');
    } catch {
      setIsSubmitting(false);
    }
  }

  return (
    <button
      className={cn(
        'inline-flex items-center rounded-full border border-si-outline-variant/30 px-4 py-2 text-sm font-semibold text-si-on-surface transition-colors hover:bg-si-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-si-secondary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      disabled={isSubmitting}
      onClick={handleClick}
      type="button"
    >
      Log out
    </button>
  );
}
