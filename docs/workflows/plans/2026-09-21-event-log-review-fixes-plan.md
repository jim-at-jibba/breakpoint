# Event log review fixes plan

1. Add a bounded request-id contract and a shared serialized-byte counter; test the boundary.
2. Implement byte-budgeted log reads, explicit read-time text truncation, immutable entries, and regression tests for ordering, continuation, Unicode, and mutation.
3. Replace CLI parameter assertions with route-checked command parsers and preserve flags after missing values; add parser, type, and subprocess regressions.
4. Exercise oversized failures and byte-limited pagination through the real Electron socket and CLI. Update public documentation and ADR.
5. Run unit tests, typechecks, build, integration tests, lint, and diff checks; review all four findings against the finished changes.

Unresolved questions: none.

## Verification

- All four review findings addressed; 22 unit and 3 Electron integration tests added.
- The full-size CLI regression exposed premature `process.exit()` truncating stdout at 64 KiB. CLI exits now use `process.exitCode` so pending output drains; the regression passes.
- `npm run test:unit`: 193 passed.
- `npm run build`: production build and both TypeScript checks passed.
- `npx playwright test`: all 41 passed, including oversized failures, byte-limited continuation, request-id boundaries, and JSON usage errors.
- `npm run lint`: zero errors; 18 existing formatting warnings in unchanged site files.
- `git diff --check`: passed.
- Final review checked byte/envelope accounting, explicit truncation, immutable entry ownership, route-specific parameter construction, and preservation of repeated-flag validation.
