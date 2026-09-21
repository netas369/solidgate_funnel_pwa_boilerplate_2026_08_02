# Minimal renewal audit reproductions

The 557-line test retains only the original repository fixtures/write-spy helper required by eight audit invariants. It imports the real current Solidgate handler. The 223 original tests were removed using the TypeScript AST; none are skipped in this version. No source edits or external operations were performed.

Result on 2026-09-14: **8 expected-invariant failures out of 8 tests**, confirming the same eight reported behaviors. These intentionally failing tests describe desired behavior and must not be mistaken for failures of the pre-existing test suite. Full failure output: `minimal-result.txt`. Concise list: `minimal-result-summary.txt`.

Run from the repository root:

```sh
node node_modules/vitest/vitest.mjs run --config /tmp/solidgate-renewals-audit/vitest.minimal.config.mts
```

Both test imports and config aliases currently point at `/Users/Netas/Projects/solidgate_funnel_pwa_boilerplate_2026_08_02`. The config include points at `/tmp/solidgate-renewals-audit/renewals-audit-minimal.test.ts`. If archiving elsewhere, update these paths. The `/tmp` folder's `node_modules` symlink resolves the existing repository Vitest dependency and is not necessary if a relocated config resolves packages through the repository.

Relevant artifacts to archive: `renewals-audit-minimal.test.ts`, `vitest.minimal.config.mts`, `minimal-result.txt`, `minimal-result-summary.txt`, `README-minimal.md`.

Limit: the database helper records requested writes rather than executing SQL transactions/constraints. These tests establish handler-level faults, not actual live-provider incidence or production balances. The missing-term test is a contract-hardening scenario; the historical-invoice last-update scenario remains subject to provider-envelope verification, as explained in the main audit report.
