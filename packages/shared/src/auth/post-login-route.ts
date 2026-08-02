export interface PostLoginSessionSnapshot {
  lastOtoStep: string | null;
  updatedAt: string | null;
}

const ACTIVE_OTO_WINDOW_MS = 24 * 60 * 60 * 1000;

export function resolvePostLoginDestination(
  input: PostLoginSessionSnapshot & { now?: Date },
): '/dashboard' | `/oto/${string}` {
  const { lastOtoStep, updatedAt, now = new Date() } = input;

  if (!lastOtoStep || !updatedAt) {
    return '/dashboard';
  }

  const updatedAtMs = new Date(updatedAt).getTime();

  if (Number.isNaN(updatedAtMs)) {
    return '/dashboard';
  }

  return now.getTime() - updatedAtMs < ACTIVE_OTO_WINDOW_MS
    ? `/oto/${lastOtoStep}`
    : '/dashboard';
}
