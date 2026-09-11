'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useQuizStore } from '@/stores/quiz-store';
import { captureInternalEvent } from '../lib/internal';

export function InternalPageView() {
  const pathname = usePathname();
  const locale = useLocale();

  useEffect(() => {
    if (!pathname) return;
    const sessionId = useQuizStore.getState().sessionId;
    captureInternalEvent('page_view', {
      path: pathname,
      locale,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }, [locale, pathname]);

  return null;
}
