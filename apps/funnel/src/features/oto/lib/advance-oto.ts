export type OtoCurrentStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type OtoResumeStep = OtoCurrentStep | 8;
export type OtoRoute = `/oto/${OtoResumeStep}`;

const DEFAULT_PROGRESS_WAIT_MS = 250;
const PROGRESS_QUEUE_PREFIX = 'solidgate-oto-progress:';
const CANONICAL_PROGRESS_PREFIX = 'solidgate-oto-canonical:';
export const OTO_CANONICAL_PROGRESS_EVENT = 'solidgate:oto-canonical-progress';
const VALID_CURRENT_STEPS = new Set<OtoCurrentStep>([1, 2, 3, 4, 5, 6, 7]);
const VALID_RESUME_STEPS = new Set<OtoResumeStep>([1, 2, 3, 4, 5, 6, 7, 8]);
const memoryQueues = new Map<string, Set<OtoCurrentStep>>();
const memoryCompletedSteps = new Map<string, Set<OtoCurrentStep>>();
const memoryCanonicalProgress = new Map<string, OtoResumePayload>();

type FetchLike = typeof fetch;

export interface OtoResumePayload {
  lastOtoStep?: unknown;
  resumeTo?: unknown;
  /** Compatibility with responses produced before durable progress existed. */
  nextOto?: unknown;
}

export interface PersistOtoProgressOptions {
  sessionId: string | null;
  currentStep: OtoCurrentStep;
  /** The request keeps running after this UI wait budget expires. */
  waitMs?: number;
  fetchImpl?: FetchLike;
}

export interface FlushOtoProgressOptions {
  sessionId: string | null;
  fetchImpl?: FetchLike;
}

interface ProgressFlushResult extends OtoResumePayload {
  persisted: boolean;
}

function progressQueueKey(sessionId: string): string {
  return `${PROGRESS_QUEUE_PREFIX}${sessionId}`;
}

export function canonicalProgressKey(sessionId: string): string {
  return `${CANONICAL_PROGRESS_PREFIX}${sessionId}`;
}

function parseOtoStep(value: unknown): OtoResumeStep | null {
  const parsed = typeof value === 'string' && /^[1-8]$/.test(value)
    ? Number(value)
    : value;
  return typeof parsed === 'number'
    && Number.isInteger(parsed)
    && VALID_RESUME_STEPS.has(parsed as OtoResumeStep)
    ? parsed as OtoResumeStep
    : null;
}

function parseOtoRoute(value: unknown): { route: OtoRoute; step: OtoResumeStep } | null {
  if (typeof value !== 'string') return null;
  const match = /^\/oto\/([1-8])$/.exec(value);
  if (!match) return null;
  const step = Number(match[1]) as OtoResumeStep;
  return { route: value as OtoRoute, step };
}

function routeForStep(step: OtoResumeStep): OtoRoute {
  return `/oto/${step}`;
}

function normalizeCanonicalProgress(payload: OtoResumePayload): OtoResumePayload | null {
  const step = parseOtoStep(payload.lastOtoStep)
    ?? parseOtoRoute(payload.resumeTo)?.step
    ?? parseOtoRoute(payload.nextOto)?.step;
  if (step === null || step === undefined) return null;
  return { lastOtoStep: String(step), resumeTo: routeForStep(step) };
}

/** Latest server-authored checkpoint, monotonically retained across navigation. */
export function readCanonicalOtoProgress(sessionId: string): OtoResumePayload {
  let stored: OtoResumePayload = {};
  try {
    const raw = window.localStorage.getItem(canonicalProgressKey(sessionId));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === 'object') stored = parsed as OtoResumePayload;
  } catch {
    // The memory fallback below remains available when storage is blocked.
  }
  return laterProgress(stored, memoryCanonicalProgress.get(sessionId) ?? {});
}

function recordCanonicalOtoProgress(sessionId: string, payload: OtoResumePayload): void {
  const normalized = normalizeCanonicalProgress(payload);
  if (!normalized) return;
  const winning = laterProgress(readCanonicalOtoProgress(sessionId), normalized);
  let stored = false;
  try {
    window.localStorage.setItem(canonicalProgressKey(sessionId), JSON.stringify(winning));
    memoryCanonicalProgress.delete(sessionId);
    stored = true;
  } catch {
    memoryCanonicalProgress.set(sessionId, winning);
  }

  window.dispatchEvent(new CustomEvent(OTO_CANONICAL_PROGRESS_EVENT, {
    detail: { sessionId, progress: winning, stored },
  }));
}

/**
 * Strict recovery navigation: only a durable checkpoint later than the page
 * currently mounted may move the buyer, and the existing locale prefix stays.
 */
export function resolveCanonicalOtoRecoveryTarget(
  payload: OtoResumePayload,
  pathname: string,
): string | null {
  const page = /^(\/[A-Za-z-]+)?\/oto\/([1-8])\/?$/.exec(pathname);
  if (!page) return null;
  const currentStep = Number(page[2]);
  const canonical = normalizeCanonicalProgress(payload);
  const canonicalStep = parseOtoStep(canonical?.lastOtoStep);
  if (canonicalStep === null || canonicalStep <= currentStep) return null;
  return `${page[1] ?? ''}${routeForStep(canonicalStep)}`;
}

/**
 * Resolves only an allowlisted same-origin OTO route. A server response may
 * move a stale tab forward, but can never send it backwards or off-site.
 */
export function resolveOtoNavigationTarget(
  payload: OtoResumePayload,
  currentStep: OtoCurrentStep,
): OtoRoute {
  const minimumStep = (currentStep + 1) as OtoResumeStep;
  const persistedStep = parseOtoStep(payload.lastOtoStep);
  const resume = parseOtoRoute(payload.resumeTo);

  if (persistedStep !== null && persistedStep >= minimumStep) {
    // Prefer the server route only when it agrees with the persisted step;
    // otherwise derive the route from the canonical numeric checkpoint.
    return resume?.step === persistedStep ? resume.route : routeForStep(persistedStep);
  }

  // Backward-compatible responses have no persisted step. Their route is
  // still restricted to the OTO allowlist and the current page's floor.
  if (persistedStep === null && resume && resume.step >= minimumStep) return resume.route;
  const legacy = parseOtoRoute(payload.nextOto);
  if (persistedStep === null && legacy && legacy.step >= minimumStep) return legacy.route;
  return routeForStep(minimumStep);
}

function readProgressQueue(sessionId: string): OtoCurrentStep[] {
  const pending = new Set<OtoCurrentStep>(memoryQueues.get(sessionId) ?? []);
  try {
    const raw = window.localStorage.getItem(progressQueueKey(sessionId));
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === 'number' && VALID_CURRENT_STEPS.has(value as OtoCurrentStep)) {
          pending.add(value as OtoCurrentStep);
        }
      }
    }
  } catch {
    // The in-memory queue above remains usable when storage reads are blocked.
  }

  // If a storage write failed after a successful request, do not resurrect
  // that completed step from a stale localStorage value.
  for (const completed of memoryCompletedSteps.get(sessionId) ?? []) pending.delete(completed);
  return [...pending].sort((left, right) => left - right);
}

function writeProgressQueue(sessionId: string, steps: OtoCurrentStep[]): boolean {
  const normalized = [...new Set(steps)].sort((left, right) => left - right);
  try {
    if (normalized.length > 0) {
      window.localStorage.setItem(progressQueueKey(sessionId), JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(progressQueueKey(sessionId));
    }
    memoryQueues.delete(sessionId);
    memoryCompletedSteps.delete(sessionId);
    return true;
  } catch {
    // Keep the complete merged snapshot, not only the newest step. Reads must
    // consult it even when getItem still works (for example Safari quota mode).
    memoryQueues.set(sessionId, new Set(normalized));
    return false;
  }
}

function enqueueProgressStep(sessionId: string, step: OtoCurrentStep): void {
  memoryCompletedSteps.get(sessionId)?.delete(step);
  writeProgressQueue(sessionId, [...readProgressQueue(sessionId), step]);
}

function completeProgressStep(sessionId: string, step: OtoCurrentStep): void {
  const completed = memoryCompletedSteps.get(sessionId) ?? new Set<OtoCurrentStep>();
  completed.add(step);
  memoryCompletedSteps.set(sessionId, completed);
  writeProgressQueue(
    sessionId,
    readProgressQueue(sessionId).filter((candidate) => candidate !== step),
  );
}

async function responseProgress(response: Response): Promise<OtoResumePayload> {
  try {
    const body = await response.json() as OtoResumePayload;
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function laterProgress(
  current: OtoResumePayload,
  candidate: OtoResumePayload,
): OtoResumePayload {
  const currentStep = parseOtoStep(current.lastOtoStep)
    ?? parseOtoRoute(current.resumeTo)?.step
    ?? 0;
  const candidateStep = parseOtoStep(candidate.lastOtoStep)
    ?? parseOtoRoute(candidate.resumeTo)?.step
    ?? 0;
  return candidateStep >= currentStep ? candidate : current;
}

async function flushProgressQueue(
  sessionId: string,
  fetchImpl: FetchLike,
): Promise<ProgressFlushResult> {
  let recoveryAttempts = 0;
  let canonical: OtoResumePayload = {};

  while (true) {
    const currentStep = readProgressQueue(sessionId)[0];
    if (!currentStep) return { persisted: true, ...canonical };

    const response = await fetchImpl('/api/solidgate/advance-oto', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, currentStep }),
    });
    const progress = await responseProgress(response);
    recordCanonicalOtoProgress(sessionId, progress);
    canonical = laterProgress(canonical, progress);

    if (response.ok) {
      completeProgressStep(sessionId, currentStep);
      continue;
    }

    // If the previous page's best-effort write was lost, the server returns
    // its exact durable step. Repair only a one-step hole, then replay this
    // request; larger gaps remain blocked rather than trusting a deep link.
    if (response.status === 409 && recoveryAttempts < 2) {
      const persistedStep = parseOtoStep(progress.lastOtoStep);
      if (
        persistedStep !== null
        && persistedStep < 8
        && persistedStep + 1 === currentStep
      ) {
        enqueueProgressStep(sessionId, persistedStep as OtoCurrentStep);
        recoveryAttempts += 1;
        continue;
      }
    }

    return { persisted: false, ...canonical };
  }
}

async function persistOtoProgressWithResult({
  sessionId,
  currentStep,
  waitMs = DEFAULT_PROGRESS_WAIT_MS,
  fetchImpl = fetch,
}: PersistOtoProgressOptions): Promise<ProgressFlushResult> {
  if (!sessionId) return { persisted: false };

  enqueueProgressStep(sessionId, currentStep);
  // The flush continues after the UI wait expires. Pending steps survive SPA
  // navigation and reload so one transient failure cannot strand resume state.
  const request = flushProgressQueue(sessionId, fetchImpl).catch(() => ({ persisted: false }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProgressFlushResult>((resolve) => {
    timer = setTimeout(() => resolve({ persisted: false }), Math.max(0, waitMs));
  });

  const result = await Promise.race([request, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/**
 * Starts a durable, session-authorized OTO advance and waits only for a small
 * UI budget. `keepalive` lets the request finish after client-side navigation;
 * failures remain queued for the next OTO mount.
 */
export async function persistOtoProgressBestEffort(
  options: PersistOtoProgressOptions,
): Promise<boolean> {
  return (await persistOtoProgressWithResult(options)).persisted;
}

/** Replays progress left by an offline/5xx prior page. Called by every OTO mount. */
export async function flushPendingOtoProgressBestEffort({
  sessionId,
  fetchImpl = fetch,
}: FlushOtoProgressOptions): Promise<boolean> {
  if (!sessionId) return false;
  try {
    return (await flushProgressQueue(sessionId, fetchImpl)).persisted;
  } catch {
    return false;
  }
}

export async function advanceOtoBeforeNavigation(options: PersistOtoProgressOptions & {
  navigate: (target: OtoRoute) => void;
}): Promise<void> {
  let progress: OtoResumePayload = {};
  try {
    progress = await persistOtoProgressWithResult(options);
  } finally {
    options.navigate(resolveOtoNavigationTarget(progress, options.currentStep));
  }
}
