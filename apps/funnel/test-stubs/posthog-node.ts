// Test stub for the Deno-only `npm:posthog-node` specifier imported by
// supabase/functions/solidgate-webhooks/index.ts. Vite cannot resolve `npm:*`
// URL specifiers, and posthog-node is not a dependency of the funnel app
// (it only runs in the Supabase Edge runtime). vitest.config.mts aliases
// `npm:posthog-node` to this file so the webhook module loads under vitest.
//
// The webhook gates all PostHog use behind getPostHog(), which returns null
// when NEXT_PUBLIC_POSTHOG_KEY/HOST are unset — tests never set them, so this
// class is effectively never instantiated. The methods exist only to satisfy
// the import surface (`new PostHog`, `.capture`, `.shutdown`).

export class PostHog {
  constructor(_key?: string, _options?: Record<string, unknown>) {}
  capture(_payload?: unknown): void {}
  flush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
