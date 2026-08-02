'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@repo/i18n/navigation';
import { useQuizStore } from '@/stores/quiz-store';
import { useFunnelStore } from '@/stores/funnel-store';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { SEGMENT_CONFIGS, GENERIC_STATS, type SegmentKey } from '../config/results-config';
import { ResultsHero } from './results-hero';
import { ResultsBenefits } from './results-benefits';
import { ResultsStats } from './results-stats';
import { ResultsTestimonials } from './results-testimonials';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

export function ResultsPage() {
  const t = useTranslations('common.results');
  const router = useRouter();
  const isComplete = useQuizStore((s) => s.isComplete);
  const sessionId = useQuizStore((s) => s.sessionId);
  const primaryGoal = useQuizStore((s) => s.answers['primaryGoal']) as SegmentKey | undefined;
  const setStage = useFunnelStore((s) => s.setStage);
  const { track } = useAnalytics();

  // Funnel gate  -  redirect if quiz not completed (D-09)
  useEffect(() => {
    if (!isComplete || !sessionId) {
      router.replace('/quiz');
    }
  }, [isComplete, sessionId, router]);

  // Mount effects  -  stage, analytics, Supabase write (D-03, D-10)
  useEffect(() => {
    if (!isComplete || !sessionId || !primaryGoal) return;
    setStage('results');
    track('oto_viewed', { session_id: sessionId, segment: primaryGoal });
    // Fire-and-forget result_segment write (D-03, D-10)
    fetch('/api/session/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, resultSegment: primaryGoal }),
    }).catch((err) => {
      console.error('[results] result_segment persist failed:', err);
    });
  }, [isComplete, sessionId, primaryGoal, setStage, track]);

  // Early return null while gate is pending  -  prevents flash of content (Pitfall 1)
  if (!isComplete || !primaryGoal || !(primaryGoal in SEGMENT_CONFIGS)) return null;
  const segment = SEGMENT_CONFIGS[primaryGoal];

  return (
    <div className="min-h-screen bg-si-surface">
      <nav className="sticky top-0 z-50 flex h-14 items-center justify-center border-b border-si-outline-variant/20 bg-white/60 backdrop-blur-md">
        <span className="font-heading text-lg font-bold">
          <span className="bg-gradient-to-r from-si-primary to-si-on-primary-container bg-clip-text text-transparent">
            {BOILERPLATE_BRAND.shortName}
          </span>{' '}
          <span className="text-si-on-surface">{t('navLabel')}</span>
        </span>
      </nav>
      <div className="mx-auto max-w-[560px] px-4 py-8 lg:px-6">
        <ResultsHero segment={segment} />
        <div className="mt-8">
          <ResultsBenefits benefits={segment.benefits} />
        </div>
        <div className="mt-8">
          <ResultsStats stats={GENERIC_STATS} />
        </div>
        <div className="mt-8">
          <ResultsTestimonials testimonials={segment.testimonials} />
        </div>
        <div className="mt-8 mb-8">
          <button
            type="button"
            onClick={() => router.push('/offer')}
            className="flex h-13 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl text-sm font-semibold text-white signature-gradient transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            {t('continueToOffer')}
          </button>
        </div>
      </div>
    </div>
  );
}
