'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@repo/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALE_CURRENCY_MAP, type Locale } from '@repo/shared/price-map';
import { useQuizStore } from '@/stores/quiz-store';
import { useQuizNavigation } from '@/features/quiz/hooks/use-quiz-navigation';
import { useQuizHydration } from '@/features/quiz/hooks/use-quiz-hydration';
import { useImagePrefetch } from '@/features/quiz/hooks/use-image-prefetch';
import {
  QuizSessionApiError,
  captureLeadRecord,
  completeQuizSession,
  createQuizSession,
  saveQuizProgress,
  readQuizSession,
} from '@/features/quiz/hooks/use-quiz-persistence';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { identifyPostHogUser, capturePostHogEvent } from '@/features/analytics/lib/posthog';
import { hashEmail } from '@/features/analytics/lib/hash-email';
import { setMetaUserData } from '@/features/analytics/lib/meta-pixel';
import { pushDataLayerEvent } from '@/features/analytics/lib/gtm';
import { useFunnelStore } from '@/stores/funnel-store';
import { NAME_KEYS, titleCase } from '@/features/quiz/lib/name';
import { markSessionReady, resetSessionGate } from '@/features/quiz/lib/session-ready';
import { QuizProgressHeader } from './quiz-progress-header';
import { StepTransition } from './step-transition';
import { RadioStep } from './steps/radio-step';
import { MultiSelectStep } from './steps/multi-select-step';
import { InputGroupStep } from './steps/input-group-step';
import { LoadingScreenStep } from './steps/loading-screen-step';
import { EmailCaptureStep } from './steps/email-capture-step';
import { PictureSelectStepView } from './steps/picture-select-step';
import { TextSelectStepView } from './steps/text-select-step';
import { ChipSelectStepView } from './steps/chip-select-step';
import { CheckpointStepView } from './steps/checkpoint-step';
import { LikertStepView } from './steps/likert-step';
import { SliderStepView } from './steps/slider-step';
import { DateWheelStepView } from './steps/date-wheel-step';
import { TimeWheelStepView } from './steps/time-wheel-step';
import { CheckpointRevealStepView } from './steps/checkpoint-reveal-step';
import { AnalysisLoaderStepView } from './steps/analysis-loader-step';
import { TrialPriceStepView } from './steps/trial-price-step';
import { ExpertNoteStepView } from './steps/expert-note-step';
import { SocialWallStepView } from './steps/social-wall-step';
import type { QuizStep } from '@/features/quiz/config/quiz-schema';
import type { EmailConsentData } from '@/features/quiz/config/consent';
// landing.css supplies the .lmRoot/.quizType base (--paper/--ink/--hairline and
// the type scale) that every step component styles against. Deleting it blanks
// the quiz visually with no build error.
import '@/app/[locale]/_components/landing/landing.css';
// Quiz-only tokens layered on top — the single file to edit when re-skinning.
import './quiz-tokens.css';

// ─── Step chrome tables ──────────────────────────────────────────────────────
//
// Two lookup tables instead of a pile of `const isX = step.type === '…'`
// booleans and a nested background ternary. Adding a step type means adding one
// entry here (plus the schema member and the renderStep case) — nothing else in
// this file changes.

/**
 * Step types that own the entire viewport: rendered with no progress header and
 * no slide transition, because the component draws its own chrome.
 */
const FULL_BLEED = new Set<QuizStep['type']>([
  'loading_screen',
  'picture_select',
  'text_select',
  'chip_select',
  'checkpoint',
  'checkpoint_reveal',
  'likert',
  'slider',
  'date_wheel',
  'time_wheel',
  'analysis_loader',
  'email_capture',
  'trial_price',
  'expert_note',
  'social_wall',
  'input_group',
]);

/**
 * Page background per step type. Values are CSS custom properties declared in
 * the quiz stylesheet, so a new product re-skins every screen from one file
 * instead of hunting hex literals across ~15 step components.
 *
 * Anything not listed falls back to DEFAULT_STEP_BACKGROUND.
 */
const DEFAULT_STEP_BACKGROUND = 'var(--paper)';

const STEP_BACKGROUND: Partial<Record<QuizStep['type'], string>> = {
  // Light surface: question + form screens.
  picture_select: 'var(--quiz-surface-light)',
  text_select: 'var(--quiz-surface-light)',
  chip_select: 'var(--quiz-surface-light)',
  likert: 'var(--quiz-surface-light)',
  slider: 'var(--quiz-surface-light)',
  date_wheel: 'var(--quiz-surface-light)',
  time_wheel: 'var(--quiz-surface-light)',
  input_group: 'var(--quiz-surface-light)',
  trial_price: 'var(--quiz-surface-light)',
  expert_note: 'var(--quiz-surface-light)',
  social_wall: 'var(--quiz-surface-light)',
  // Dark surface: reveals, gates and loaders.
  checkpoint: 'var(--quiz-surface-dark)',
  checkpoint_reveal: 'var(--quiz-surface-dark)',
  analysis_loader: 'var(--quiz-surface-dark)',
  email_capture: 'var(--quiz-surface-dark)',
};

export function QuizPage() {
  const hydrated = useQuizHydration();
  const [sessionInitialized, setSessionInitialized] = useState(false);
  const isComplete = useQuizStore((s) => s.isComplete);
  const setSessionId = useQuizStore((s) => s.setSessionId);
  const { track } = useAnalytics();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const bootstrapRouter = useRouter();

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    resetSessionGate();

    const routeToOffer = () => {
      const tier = useQuizStore.getState().answers['trialTier'];
      bootstrapRouter.replace(
        typeof tier === 'string' && tier
          ? `/offer/details?tier=${encodeURIComponent(tier)}`
          : '/offer',
      );
    };

    const createFreshSession = async (
      recovery?: {
        currentStepId: string;
        answers: Record<string, string | string[] | number>;
      },
      requestedSessionId?: string,
    ) => {
      const sid = requestedSessionId ?? crypto.randomUUID();
      setSessionId(sid);
      const created = await createQuizSession({ sessionId: sid, locale });
      if (cancelled) return;
      if (!created) {
        // The API identified a known Meta crawler. Remove the temporary local
        // ID, render the public quiz screen normally, and emit no quiz events.
        useQuizStore.getState().reset();
        return;
      }
      const recoveredAnswers = recovery?.answers ?? {};
      const recoveredStep = recovery?.currentStepId ?? null;
      useQuizStore.getState().restoreSession({
        id: created.id,
        currentStepId: recoveredStep,
        answers: recoveredAnswers,
        revision: created.revision,
        isComplete: false,
        hasUnsavedProgress: Boolean(recovery),
      });
      track('quiz_started', { session_id: created.id });
      if (recovery) {
        await saveQuizProgress(created.id, recovery.currentStepId, recoveredAnswers, {
          locale,
        });
      }
    };

    const initialize = async () => {
      const restart = searchParams.get('restart') === 'true';
      if (restart) useQuizStore.getState().reset();

      const local = useQuizStore.getState();

      // Browser Back from the offer is not a new quiz. The explicit restart
      // query remains the only way to discard a completed journey.
      if (!restart && local.isComplete && local.sessionId) {
        routeToOffer();
        return;
      }

      if (!restart && local.sessionId) {
        try {
          const server = await readQuizSession(local.sessionId);
          if (cancelled) return;
          const pendingAnswers = local.hasUnsavedProgress
            ? { ...server.quiz_answers, ...local.answers }
            : server.quiz_answers;
          const resumeStep = local.hasUnsavedProgress
            ? local.currentStepId
            : server.current_step_id;
          useQuizStore.getState().restoreSession({
            id: server.id,
            currentStepId: resumeStep,
            answers: pendingAnswers,
            revision: server.revision,
            isComplete: server.status === 'completed',
            hasUnsavedProgress: local.hasUnsavedProgress,
          });

          if (server.status === 'completed') {
            routeToOffer();
            return;
          }
          if (local.hasUnsavedProgress) {
            await saveQuizProgress(server.id, resumeStep ?? local.currentStepId, pendingAnswers, {
              locale,
            });
          }
          return;
        } catch (error) {
          const inaccessible = error instanceof QuizSessionApiError && [401, 403].includes(error.status);
          const missing = error instanceof QuizSessionApiError && error.status === 404;
          if (missing) {
            // A previous create request may have been interrupted before its
            // response arrived. Reuse the same client-generated ID; the
            // creation helper also deduplicates React Strict Mode replays.
            const recovery = local.hasUnsavedProgress
              ? { currentStepId: local.currentStepId, answers: local.answers }
              : undefined;
            await createFreshSession(recovery, local.sessionId);
            return;
          }
          if (!inaccessible) throw error;
          // A local UUID without its signed cookie cannot take ownership of an
          // old anonymous session. Start an authorized replacement and carry
          // forward only this browser's explicitly unsaved local progress.
          const recovery = local.hasUnsavedProgress
            ? { currentStepId: local.currentStepId, answers: local.answers }
            : undefined;
          useQuizStore.getState().reset();
          await createFreshSession(recovery);
          return;
        }
      }

      await createFreshSession();
    };

    void initialize()
      .catch((error) => {
        console.error('[session] Quiz initialization failed:', error);
      })
      .finally(() => {
        if (cancelled) return;
        markSessionReady();
        setSessionInitialized(true);
      });

    return () => {
      cancelled = true;
    };
  }, [hydrated, setSessionId, track, searchParams, locale, bootstrapRouter]);

  if (!hydrated || !sessionInitialized) {
    return (
      <main className="lmRoot quizType" style={{ minHeight: '100dvh', background: 'var(--paper)' }}>
        <div style={{ height: 60, borderBottom: '1px solid var(--ink)' }} />
        <div style={{ maxWidth: 720, margin: '40px auto 0', padding: '0 22px' }}>
          <div style={{ height: 18, width: '60%', background: 'var(--hairline)' }} />
          <div style={{ marginTop: 24, height: 60, background: 'var(--hairline)' }} />
          <div style={{ marginTop: 12, height: 60, background: 'var(--hairline)' }} />
          <div style={{ marginTop: 12, height: 60, background: 'var(--hairline)' }} />
        </div>
      </main>
    );
  }

  if (isComplete) return null;

  return <QuizPageContent />;
}

function QuizPageContent() {
  const {
    currentStep,
    stepPosition,
    totalSteps,
    direction,
    canGoBack,
    goToStep,
    goToStepReplace,
    goBack,
    setStepAnswer,
    answers,
    answerLabels,
    resolvedCopy,
  } = useQuizNavigation(useLocale());

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [currentStep.stepId]);

  useImagePrefetch(currentStep.stepId);

  const router = useRouter();
  const t = useTranslations('quiz');
  const completeQuiz = useQuizStore((s) => s.completeQuiz);
  const { track } = useAnalytics();
  const sessionId = useQuizStore((s) => s.sessionId);
  const setStage = useFunnelStore((s) => s.setStage);
  const locale = useLocale();
  const currency = LOCALE_CURRENCY_MAP[locale as Locale] ?? 'eur';

  const hasEmail = Boolean(answers['userEmail'] || answers['email']);

  const abandonRef = useRef({ stepId: currentStep.stepId, stepPosition, hasEmail, sessionId });
  useEffect(() => {
    abandonRef.current = { stepId: currentStep.stepId, stepPosition, hasEmail, sessionId };
  }, [currentStep.stepId, stepPosition, hasEmail, sessionId]);

  useEffect(() => {
    const handler = () => {
      const { stepId, stepPosition: pos, hasEmail: has, sessionId: sid } = abandonRef.current;
      if (sid) {
        capturePostHogEvent('quiz_abandoned', {
          session_id: sid,
          step_id: stepId,
          step_position: pos,
          has_email: has,
        });
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const handleRadioSelect = useCallback(
    (nextStepId: string, storeAs: string, value: string, label: string) => {
      setStepAnswer(storeAs, value, label);
      goToStep(nextStepId);
    },
    [setStepAnswer, goToStep],
  );

  const handleMultiContinue = useCallback(
    (nextStepId: string, storeAs: string, values: string[], labels: string[]) => {
      setStepAnswer(storeAs, values, labels);
      goToStep(nextStepId);
    },
    [setStepAnswer, goToStep],
  );

  const handleMultiToggle = useCallback(
    (storeAs: string, value: string, maxSelection?: number) => {
      const current = (answers[storeAs] as string[] | undefined) ?? [];
      let updated: string[];
      if (current.includes(value)) updated = current.filter((v) => v !== value);
      else if (maxSelection && current.length >= maxSelection) updated = [...current.slice(1), value];
      else updated = [...current, value];
      setStepAnswer(storeAs, updated);
    },
    [answers, setStepAnswer],
  );

  const handleInputContinue = useCallback(
    (nextStepId: string, fieldValues: Record<string, string | number>) => {
      for (const [storeAs, value] of Object.entries(fieldValues)) {
        const normalized =
          typeof value === 'string' && NAME_KEYS.has(storeAs) ? titleCase(value) : value;
        setStepAnswer(storeAs, normalized);
      }
      goToStep(nextStepId);
    },
    [setStepAnswer, goToStep],
  );

  // The wheel steps write to the key the CONFIG declares (`step.storeAs`) plus
  // derived component keys, rather than to hardcoded names — so a product can
  // ask for any date/time without editing this file.
  const handleDateWheelContinue = useCallback(
    (nextStepId: string, storeAs: string, date: { day: number; month: number; year: number }) => {
      const iso = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
      const label = new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date(date.year, date.month - 1, date.day));
      setStepAnswer(storeAs, iso, label);
      setStepAnswer(`${storeAs}Day`, String(date.day));
      setStepAnswer(`${storeAs}Month`, String(date.month));
      setStepAnswer(`${storeAs}Year`, String(date.year));
      goToStep(nextStepId);
    },
    [setStepAnswer, goToStep, locale],
  );

  const handleTimeWheelContinue = useCallback(
    (nextStepId: string, storeAs: string, time: { hour: number; minute: number }) => {
      const hh = String(time.hour).padStart(2, '0');
      const mm = String(time.minute).padStart(2, '0');
      setStepAnswer(storeAs, `${hh}:${mm}`, `${hh}:${mm}`);
      setStepAnswer(`${storeAs}Hour`, String(time.hour));
      setStepAnswer(`${storeAs}Minute`, String(time.minute));
      goToStep(nextStepId);
    },
    [setStepAnswer, goToStep],
  );

  const handleEmailSubmit = useCallback(
    async (data: EmailConsentData) => {
      const { email, consentGivenAt, consentVersion, marketingConsent } = data;
      // Honour the step's declared key, and keep writing the legacy
      // 'userEmail' alias: downstream readers (offer, success) still look it up
      // by that name, and the two must not drift apart.
      const storeAs = (currentStep as { storeAs?: string }).storeAs ?? 'email';
      setStepAnswer(storeAs, email, email);
      if (storeAs !== 'userEmail') setStepAnswer('userEmail', email, email);

      if (sessionId) {
        const result = await captureLeadRecord(sessionId, email, useQuizStore.getState().answers, {
          consentGivenAt,
          consentVersion,
          marketingConsent,
        }, locale, currentStep.stepId, stepPosition);
        if (result.success) {
          // Hash email up front so we can attach it to the Meta Pixel as
          // advanced-matching userData BEFORE firing the Lead event. Without
          // this, Meta has no PII to match the pageview/lead → iOS 14+ user,
          // and match quality drops dramatically. The same hash also goes to
          // GTM for downstream pixels. The CAPI route reads the just-persisted
          // email from the session and hashes it server-side; raw email never
          // reaches PostHog/GTM/fbq or the browser request body.
          const emailHashed = await hashEmail(email);
          setMetaUserData(emailHashed);
          track('lead_captured', { session_id: sessionId, capi_email: email });
          identifyPostHogUser(sessionId, email, { locale, currency });
          pushDataLayerEvent('lead_captured', { session_id: sessionId, email_hashed: emailHashed });
        } else {
          track('lead_capture_error', { session_id: sessionId, retry_required: true });
          return false;
        }
      } else {
        return false;
      }
      setStage('lead_capture');
      // Continue to whichever step is configured next on the email step.
      goToStep((currentStep as { nextStepId: string }).nextStepId);
      return true;
    },
    [
      setStepAnswer,
      sessionId,
      track,
      setStage,
      goToStep,
      locale,
      currency,
      currentStep,
      stepPosition,
    ],
  );

  // Save the complete final answer state, then ask the backend to validate, score,
  // and complete the session atomically before the offer becomes reachable.
  const finalizeAndNavigate = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      try {
        const answers = useQuizStore.getState().answers;
        await saveQuizProgress(sessionId, currentStep.stepId, answers, { locale });
        const completed = await completeQuizSession(sessionId);
        completeQuiz(completed.revision);
        track('quiz_completed', {
          session_id: sessionId,
          result_segment: completed.resultSegment,
        });
        router.push(path);
      } catch (error) {
        // Do not expose the offer while required quiz state is uncommitted.
        // The terminal screen stays mounted, allowing a reload to resume and
        // retry from the locally retained answers.
        console.error('[quiz] Completion failed:', error);
      }
    },
    [completeQuiz, currentStep.stepId, locale, sessionId, track, router],
  );

  const handleLoadingComplete = useCallback(() => finalizeAndNavigate('/offer'), [finalizeAndNavigate]);

  // The trial-price step is terminal: the visitor already picked a tier, so
  // complete the quiz and jump straight to the personalized offer/details page
  // for that tier (skipping the redundant /offer picker).
  const handleTrialPriceComplete = useCallback(() => {
    const tier = useQuizStore.getState().answers['trialTier'] as string | undefined;
    return finalizeAndNavigate(tier ? `/offer/details?tier=${encodeURIComponent(tier)}` : '/offer');
  }, [finalizeAndNavigate]);

  const stepNode = renderStep(currentStep, {
    t,
    tRaw: (key: string) => String(t.raw(key)),
    answers,
    answerLabels,
    resolvedCopy,
    onRadioSelect: handleRadioSelect,
    onMultiToggle: handleMultiToggle,
    onMultiContinue: handleMultiContinue,
    onInputContinue: handleInputContinue,
    onEmailSubmit: handleEmailSubmit,
    onInfoContinue: goToStep,
    onLoadingAdvance: goToStepReplace,
    onLoadingComplete: handleLoadingComplete,
    onTrialPriceComplete: handleTrialPriceComplete,
    onDateWheelContinue: handleDateWheelContinue,
    onTimeWheelContinue: handleTimeWheelContinue,
    onBack: goBack,
    progress: totalSteps > 0 ? stepPosition / totalSteps : 0,
  });

  const phaseLabel = (() => {
    try {
      return t(currentStep.phase);
    } catch {
      return '';
    }
  })();

  const isFullBleed = FULL_BLEED.has(currentStep.type);

  return (
    <main
      className="lmRoot quizType"
      style={{
        minHeight: '100dvh',
        background: STEP_BACKGROUND[currentStep.type] ?? DEFAULT_STEP_BACKGROUND,
        position: 'relative',
      }}
    >
      {!isFullBleed && (
        <QuizProgressHeader
          currentStep={stepPosition - 1}
          totalQuestions={totalSteps}
          onBack={goBack}
          showBack={canGoBack}
          showProgress
          phaseName={phaseLabel}
        />
      )}
      <div style={{ position: 'relative' }}>
        {isFullBleed ? (
          stepNode
        ) : (
          <StepTransition questionId={currentStep.stepId} direction={direction}>
            {stepNode}
          </StepTransition>
        )}
      </div>
    </main>
  );
}

interface StepHandlers {
  t: ReturnType<typeof useTranslations>;
  tRaw: (key: string) => string;
  answers: Record<string, string | string[] | number>;
  answerLabels: Record<string, string | string[]>;
  resolvedCopy: (template: string) => string;
  onRadioSelect: (nextStepId: string, storeAs: string, value: string, label: string) => void;
  onMultiToggle: (storeAs: string, value: string, maxSelection?: number) => void;
  onMultiContinue: (nextStepId: string, storeAs: string, values: string[], labels: string[]) => void;
  onInputContinue: (nextStepId: string, fieldValues: Record<string, string | number>) => void;
  onEmailSubmit: (data: EmailConsentData) => void | boolean | Promise<void | boolean>;
  onInfoContinue: (nextStepId: string) => void;
  // Auto-advancing steps REPLACE themselves in history — otherwise browser-Back
  // from the next step lands on a screen that instantly moves forward again.
  onLoadingAdvance: (nextStepId: string) => void;
  onLoadingComplete: () => void;
  onTrialPriceComplete: () => void;
  onDateWheelContinue: (
    nextStepId: string,
    storeAs: string,
    date: { day: number; month: number; year: number },
  ) => void;
  onTimeWheelContinue: (
    nextStepId: string,
    storeAs: string,
    time: { hour: number; minute: number },
  ) => void;
  onBack: () => void;
  progress: number;
}

function renderStep(step: QuizStep, h: StepHandlers): React.ReactNode {
  switch (step.type) {
    case 'radio':
      return (
        <RadioStep
          step={step}
          t={h.t}
          selectedValue={h.answers[step.storeAs] as string | undefined}
          onSelect={h.onRadioSelect}
        />
      );
    case 'multi_select':
      return (
        <MultiSelectStep
          step={step}
          t={h.t}
          selectedValues={(h.answers[step.storeAs] as string[] | undefined) ?? []}
          onToggle={h.onMultiToggle}
          onContinue={h.onMultiContinue}
        />
      );
    case 'input_group':
      return <InputGroupStep step={step} t={h.t} onContinue={h.onInputContinue} onBack={h.onBack} />;
    case 'loading_screen':
      return (
        <LoadingScreenStep
          step={step}
          t={h.t}
          resolvedCopy={(key: string) => h.resolvedCopy(h.tRaw(key))}
          onComplete={h.onLoadingComplete}
        />
      );
    case 'email_capture':
      return (
        <EmailCaptureStep
          step={step}
          t={h.t}
          tRaw={h.tRaw}
          resolvedCopy={h.resolvedCopy}
          onSubmit={h.onEmailSubmit}
          onBack={h.onBack}
        />
      );
    case 'picture_select':
      return (
        <PictureSelectStepView
          step={step}
          t={h.t}
          selectedValue={h.answers[step.storeAs] as string | undefined}
          onSelect={h.onRadioSelect}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'text_select':
      return (
        <TextSelectStepView
          step={step}
          t={h.t}
          selectedValue={h.answers[step.storeAs] as string | undefined}
          onSelect={h.onRadioSelect}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'chip_select':
      return (
        <ChipSelectStepView
          step={step}
          t={h.t}
          selectedValue={h.answers[step.storeAs] as string | undefined}
          onSelect={h.onRadioSelect}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'checkpoint':
      return (
        <CheckpointStepView
          step={step}
          t={h.t}
          answers={h.answers}
          onContinue={h.onInfoContinue}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'likert':
      return (
        <LikertStepView
          step={step}
          t={h.t}
          initialValue={h.answers[step.storeAs] as string | undefined}
          onContinue={h.onRadioSelect}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'slider':
      return (
        <SliderStepView
          step={step}
          t={h.t}
          initialValue={h.answers[step.storeAs] as string | undefined}
          onContinue={h.onRadioSelect}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'date_wheel':
      return (
        <DateWheelStepView
          step={step}
          t={h.t}
          initialValue={h.answers[step.storeAs] as string | undefined}
          onContinue={h.onDateWheelContinue}
          onBack={h.onBack}
        />
      );
    case 'time_wheel':
      return (
        <TimeWheelStepView
          step={step}
          t={h.t}
          initialValue={h.answers[step.storeAs] as string | undefined}
          onContinue={h.onTimeWheelContinue}
          onBack={h.onBack}
        />
      );
    case 'checkpoint_reveal':
      return (
        <CheckpointRevealStepView
          step={step}
          t={h.t}
          // Auto-advances on a timer, so it replaces itself in history —
          // otherwise Back from the next step would bounce straight forward.
          onContinue={h.onLoadingAdvance}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'analysis_loader':
      return (
        <AnalysisLoaderStepView
          step={step}
          t={h.t}
          onContinue={h.onInfoContinue}
          onBack={h.onBack}
        />
      );
    case 'social_wall':
      return (
        <SocialWallStepView
          step={step}
          t={h.t}
          onContinue={h.onInfoContinue}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'expert_note':
      return (
        <ExpertNoteStepView
          step={step}
          t={h.t}
          onContinue={h.onInfoContinue}
          onBack={h.onBack}
          progress={h.progress}
        />
      );
    case 'trial_price':
      return (
        <TrialPriceStepView
          step={step}
          t={h.t}
          onContinue={h.onTrialPriceComplete}
          onBack={h.onBack}
        />
      );
    // The discriminated union makes the switch above exhaustive; this branch
    // only fires if a step type is added to the schema without a renderer.
    default:
      return null;
  }
}
