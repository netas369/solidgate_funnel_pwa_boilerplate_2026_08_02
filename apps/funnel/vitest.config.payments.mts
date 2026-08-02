import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Payment-surface coverage gate.
 *
 * Runs every payment-related suite — funnel checkout, Solidgate/OTO routes, the
 * webhook, and the shared Solidgate layer — and reports coverage over the
 * payment-critical sources only.
 *
 *   cd apps/funnel && npx vitest run -c vitest.config.payments.mts
 *
 * KEEP THE GLOBS HONEST. Every include below must match at least one real file.
 * A glob that matches nothing does not fail — it silently shrinks the gate,
 * which is exactly how this config came to point at four deleted directories.
 */
export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [tsconfigPaths(), react()] as any,
  resolve: {
    // Same Deno-specifier rewrites as vitest.config.mts (the webhook sources
    // import npm:* URLs vite cannot resolve).
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
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        inline: ["next-intl"],
      },
    },
    include: [
      // Funnel payment routes + client checkout surface.
      "src/app/api/solidgate/**/__tests__/**/*.test.{ts,tsx}",
      "src/app/api/orders/**/__tests__/**/*.test.{ts,tsx}",
      "src/app/api/session/**/__tests__/**/*.test.{ts,tsx}",
      "src/app/api/auth/**/__tests__/**/*.test.{ts,tsx}",
      "src/components/checkout/__tests__/**/*.test.{ts,tsx}",
      "src/lib/payment/**/__tests__/**/*.test.{ts,tsx}",
      "src/features/oto/**/__tests__/**/*.test.{ts,tsx}",
      "src/features/offer/**/__tests__/**/*.test.{ts,tsx}",
      "src/features/checkout/**/__tests__/**/*.test.{ts,tsx}",
      // Webhook (Deno function, tested from here for the alias rewrites).
      "../../supabase/functions/solidgate-webhooks/__tests__/**/*.test.{ts,tsx}",
      // Shared payment layer.
      "../../packages/shared/src/__tests__/solidgate*.test.ts",
      "../../packages/shared/src/__tests__/entitlements.test.ts",
      "../../packages/shared/src/__tests__/price-map*.test.ts",
      "../../packages/shared/src/__tests__/sql-price-grid-parity.test.ts",
      "../../packages/shared/src/__tests__/oto-product-label.test.ts",
      "../../packages/shared/src/__tests__/send-oto3-pdf-email.test.ts",
      "../../packages/shared/src/__tests__/send-welcome-email.test.ts",
      "../../packages/shared/src/__tests__/grace-period.test.ts",
      "../../packages/shared/src/__tests__/payment-*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/app/api/solidgate/**/*.ts",
        "src/app/api/orders/**/route.ts",
        "src/components/checkout/**/*.{ts,tsx}",
        "src/lib/payment/**/*.ts",
        "src/features/oto/lib/**/*.ts",
        "../../packages/shared/src/solidgate/**/*.ts",
        "../../packages/shared/src/grace-period.ts",
        "../../packages/shared/src/entitlements.ts",
        "../../packages/shared/src/price-map.ts",
      ],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "**/*.d.ts",
      ],
    },
  },
});
