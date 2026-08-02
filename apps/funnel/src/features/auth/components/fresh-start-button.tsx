'use client';

import { useState } from 'react';
import { useAnalyticsStore } from '@/stores/analytics-store';
import { useFunnelStore } from '@/stores/funnel-store';
import { useQuizStore } from '@/stores/quiz-store';
import { cn } from '@repo/shared/utils';

interface FreshStartButtonProps {
  className?: string;
}

export function FreshStartButton({ className }: FreshStartButtonProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleClick() {
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/device-reset', { method: 'POST' });

      if (!response.ok) {
        throw new Error('Failed to reset device state');
      }

      await response.json();
      useQuizStore.getState().reset();
      useQuizStore.persist?.clearStorage?.();
      useFunnelStore.setState({ currentStage: 'landing' });
      useAnalyticsStore.getState().clearEvents();
      window.location.assign('/quiz');
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
      Use this device for someone else
    </button>
  );
}
