# Project review fixes plan

1. Correct launch argument filtering and test path switches before and after the entry script.
2. Convert project persistence and canonicalisation to async I/O; check stored identity and serialize service opens. Test ordering, responsiveness, persistence failure and unchanged state.
3. Register native open handling before readiness and drain queued requests through the route table after window creation. Test early events and a running app.
4. Extract the snapshot subscription/retry lifecycle for direct testing, keep the hook thin, and expose an error plus Retry action. Test failed envelopes, rejected promises, recovery, retry limits and disposal.
5. Run unit tests, build/typechecks, Electron integration tests, lint and `git diff --check`; review the changes against all five findings.

Unresolved questions: none.

## Verification

- All five findings addressed; 17 unit and 3 Electron integration regression tests added.
- `npm run test:unit`: 140 passed.
- Production build and both TypeScript checks passed.
- Final `npx playwright test`: 34 passed, including native macOS window recreation and recovery through the real preload bridge.
- The native-open test initially raced asynchronous window closure. It now waits for `closed` before delivering the next request; the targeted test and final full suite passed.
- `npm run lint`: zero errors; 18 existing warnings in unchanged site files.
- `git diff --check`: passed.
