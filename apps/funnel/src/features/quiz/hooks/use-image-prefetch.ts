'use client';

import { useEffect, useRef } from 'react';
import { quizConfig, quizStepMap } from '@/features/quiz/config/quiz-config';

/**
 * Map of stepId → image URLs for steps that contain images.
 * Built once from quiz config so the prefetch hook doesn't need to
 * know about step type internals.
 *
 * Rather than enumerate specific fields (image, options[].image, …) — which
 * silently misses new ones like `symbols[]`, `concepts[].icon`, `icons[]`,
 * `handImage`, `orbit`, `spiral` — we walk each step object recursively and
 * collect every string that looks like an image path. Emoji `icon` values and
 * i18n keys have no image extension, so they're skipped automatically.
 */
const IMAGE_PATH_RE = /\.(webp|png|jpe?g|gif|avif)(\?|$)/i;

function collectImageUrls(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    if ((node.startsWith('/') || node.startsWith('http')) && IMAGE_PATH_RE.test(node)) {
      out.push(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectImageUrls(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectImageUrls(value, out);
  }
}

const STEP_IMAGES: Record<string, string[]> = {};

for (const step of quizConfig.steps) {
  const urls: string[] = [];
  collectImageUrls(step, urls);
  if (urls.length > 0) STEP_IMAGES[step.stepId] = urls;
}

// Escape hatch for assets a step's *component* hardcodes rather than declaring
// in the quiz config, keyed by step TYPE. The config-driven scan above cannot
// see those, so without an entry here a shared background/logo only loads when
// the step first renders — the "text first, image pops in a beat later" flash.
//
// Empty by design: the shipped step components draw their backgrounds with CSS
// and take every image from the config. Add an entry only if you hardcode a
// path in a component, and KEEP IT IN SYNC with that path — a stale entry
// silently reintroduces the flash instead of failing.
const STEP_TYPE_IMAGES: Record<string, string[]> = {};

/**
 * Collects upcoming step IDs by following the `nextStepId` chain
 * and option branches from the current step, up to `depth` steps ahead.
 */
function getUpcomingStepIds(currentStepId: string, depth: number): string[] {
  const visited = new Set<string>();
  const queue: { id: string; d: number }[] = [{ id: currentStepId, d: 0 }];

  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if (d > depth || visited.has(id)) continue;
    visited.add(id);

    const step = quizStepMap[id];
    if (!step) continue;

    // Follow nextStepId if present
    if ('nextStepId' in step && typeof step.nextStepId === 'string') {
      queue.push({ id: step.nextStepId, d: d + 1 });
    }

    // Follow all option branches (radio steps)
    if ('options' in step && Array.isArray(step.options)) {
      for (const opt of step.options) {
        if ('nextStepId' in opt && typeof opt.nextStepId === 'string') {
          queue.push({ id: opt.nextStepId, d: d + 1 });
        }
      }
    }
  }

  // Remove current step from results
  visited.delete(currentStepId);
  return Array.from(visited);
}

/**
 * Prefetches images for upcoming quiz steps so they're in the browser
 * cache before the user reaches them. Looks 5 steps ahead (following
 * branches) and preloads any images found.
 */
export function useImagePrefetch(currentStepId: string) {
  const prefetched = useRef(new Set<string>());

  useEffect(() => {
    const upcoming = getUpcomingStepIds(currentStepId, 5);
    const toPrefetch: string[] = [];

    for (const stepId of upcoming) {
      // Config-declared images (step-level + per-option) and any assets the
      // step's component hardcodes for its type (e.g. checkpoint-bg.webp).
      const urls = [
        ...(STEP_IMAGES[stepId] ?? []),
        ...(STEP_TYPE_IMAGES[quizStepMap[stepId]?.type ?? ''] ?? []),
      ];
      for (const url of urls) {
        if (!prefetched.current.has(url)) {
          toPrefetch.push(url);
          prefetched.current.add(url);
        }
      }
    }

    if (toPrefetch.length === 0) return;

    // Warm the browser cache with a real image request (normal priority) and
    // fully decode it, so the upcoming step's <Image> renders instantly with no
    // text-first / image-after flash. This is far more reliable than
    // <link rel="prefetch">, which is lowest priority and meant for navigation.
    //
    // NOTE: the funnel's step images render via next/image with `unoptimized`,
    // so the rendered request URL is the raw `/images/...` path — identical to
    // what we load here, guaranteeing a cache hit. If an image is switched to
    // optimized (`/_next/image?...`), preloading the raw path here will NOT
    // match and the flash will return.
    for (const url of toPrefetch) {
      const img = new Image();
      img.src = url;
      // decode() resolves once the image is downloaded AND decoded; ignore
      // failures (unsupported, aborted, 404) — they shouldn't break the quiz.
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {});
      }
    }
  }, [currentStepId]);
}
