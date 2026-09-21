# Emulation review fixes plan

1. Define typed emulation commands and named user-agent options; add compile-time contract checks.
2. Gate initial guest navigation on its first emulation attempt. Replace the touch-test exclusion with first-document feature detection and input-initialisation coverage.
3. Add selective pending invalidation before publishing a changed pane. Retain failure/recovery semantics and cover delayed and obsolete application results over real Electron IPC.
4. Add save rollback, concurrent update, mixed open/update and queue recovery tests with real project storage.
5. Run unit tests, typechecking/build, Electron E2E tests, lint and diff checks. Review the completed changes against the spec and for correctness/security.

Unresolved questions: none.

## Implementation notes

- Electron 44 needs a blank bootstrap document before CDP can answer; awaiting overrides before starting any document deadlocks. The bootstrap is host-internal, omitted from page observations and removed from history after the first target commit.
- Renamed `src/preload/index.d.ts` to `bridge.d.ts`: the declaration shared a basename with `index.ts`, so the Node TypeScript project omitted it. The distinct name makes the actual preload contract available to the new real-bridge tests without duplicate declarations or casts.

## Verification

- `npm run test:unit`: 273 passed, including 10 added cases.
- `npm run build`: both TypeScript checks and production bundles passed.
- `npx playwright test`: all 70 passed, including two added delayed/obsolete-result regressions and strengthened first-document touch coverage.
- `npm exec -- eslint .`: zero errors; 18 existing formatting warnings in unchanged site files.
- `git diff --check`: passed.
- Spec review: all five findings addressed. The initial target is requested once, touch-dependent initialisation runs correctly, and the internal blank page leaves no back-history entry. Pending and applied transitions reach both IPC and socket readers; obsolete answers cannot overwrite current status.
- Quality review: HTTP(S) checks still precede internal bootstrap, guest security guards pass integration coverage, attachment failure still renders and retries once after the target load, and persisted changes remain serialized and save-first.
