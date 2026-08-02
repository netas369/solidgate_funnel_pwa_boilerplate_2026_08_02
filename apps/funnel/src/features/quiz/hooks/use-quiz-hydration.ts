'use client';

import { useEffect, useState } from 'react';
import { useQuizStore } from '@/stores/quiz-store';

/**
 * Rehydrates the Zustand persist store on mount.
 * Must be called before reading persisted quiz state.
 */
export function useQuizHydration(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    useQuizStore.persist.rehydrate();
    setHydrated(true);
  }, []);

  return hydrated;
}
