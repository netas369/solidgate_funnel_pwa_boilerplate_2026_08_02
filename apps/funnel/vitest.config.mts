import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [tsconfigPaths(), react()] as any,
  resolve: {
    // Deno-style URL specifiers in supabase/functions/solidgate-webhooks/index.ts.
    // Vite can't resolve `npm:*` imports; rewrite to bare module names so vitest
    // can load the file. The test files themselves vi.mock these same
    // specifiers to stub out Supabase/PostHog, so these aliases mostly exist
    // to satisfy static analysis before mocks are applied.
    //
    // posthog-node is not a funnel-app dependency (Edge-runtime only), so it
    // resolves to a local stub instead of a real package.
    alias: [
      { find: /^npm:@supabase\/supabase-js@2$/, replacement: "@supabase/supabase-js" },
      {
        find: /^npm:posthog-node$/,
        replacement: fileURLToPath(
          new URL("./test-stubs/posthog-node.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Phase 1038 Plan 07: jest-dom matchers (toBeInTheDocument, toHaveFocus, …)
    // Registered globally so React component tests can assert rendered DOM.
    setupFiles: ["../../test-setup/webstorage.ts", "./vitest.setup.ts"],
    server: {
      deps: {
        // next-intl/navigation ESM imports next/navigation without .js extension,
        // which fails Node ESM resolution. Inlining next-intl lets Vite handle it.
        inline: ["next-intl"],
      },
    },
    include: [
      "src/**/*.test.{ts,tsx}",
      // Webhook unit tests live in supabase/ outside funnel src.
      "../../supabase/functions/solidgate-webhooks/__tests__/**/*.test.{ts,tsx}",
      // Repo-root scripts have no suite of their own; without this glob their
      // tests are collected by nothing and silently never run.
      "../../scripts/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "src/**/tests/**",
      ],
    },
  },
});
