import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Override default ignores of eslint-config-next.
  //
  // Patterns are resolved relative to THIS file (the repo root), but `lint`
  // runs per-workspace from apps/*, so an unprefixed `.next/**` only ever
  // matched a root-level build dir and let apps/*/.next through. `npm run lint`
  // then failed on generated Turbopack/Serwist output whenever anyone had
  // built before linting. Keep the `**/` prefix.
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/coverage/**",
    "**/next-env.d.ts",
    "apps/pwa/public/sw.js",
    "apps/pwa/public/sw.js.map",
  ]),

  {
    // ── Inherited React Compiler debt ────────────────────────────────────────
    //
    // These three rules ship as ERRORS in eslint-config-next. They are
    // downgraded to warnings here so `npm run lint` is green on a fresh clone,
    // and this block is the record of why — it is technical debt, not a
    // statement that the rules are wrong.
    //
    // Every current violation predates this boilerplate and sits in quiz-engine
    // state code that works and is covered by tests:
    //
    //   set-state-in-effect          8 sites — hydration/prop-sync effects in
    //                                use-quiz-hydration, step-transition,
    //                                wheel-column, wheel-pickers, radio-step,
    //                                picture-select-step, post-payment-nav
    //   refs                         1 site  — _auto-advance.tsx reads a ref
    //                                during render
    //   preserve-manual-memoization  1 site  — wheel-pickers.tsx defeats the
    //                                React Compiler's memoization
    //
    // Fixing them properly means reworking how the quiz syncs derived state,
    // which is a behavioural refactor and deserves its own change with its own
    // testing — not a drive-by edit. Until then they stay visible as warnings.
    //
    // TODO(new product): resolve these, then promote all three back to "error".
    // If you add NEW components, hold them to the error standard.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);

export default eslintConfig;
