# Wire review fixes plan

1. Update protocol framing, response validation and generic payload types. Add protocol and bridge type regression coverage.
2. Give dispatch an explicit signature, remove its assertion, catch startup rejections and test a failure after socket initialization.
3. Enforce framing limits in both socket adapters; centralize CLI error formatting and retain parsed options on usage failures.
4. Pin the harness socket environment. Add integration coverage for socket isolation, oversized requests/replies and stable CLI errors.
5. Run `npm run test:unit`, `npm run test:e2e`, `npm run lint` and `git diff --check`. Review the final diff against all seven findings.

Unresolved questions: none.

## Verification

- All seven findings addressed; protocol and CLI behavior documented in the CLI reference.
- `npm run test:unit`: 81 passed.
- `npm run test:e2e`: build and both typechecks passed; 19 integration tests passed.
- The existing minimize/handoff test exposed a window-show race. The harness now waits for the initial window to be visible; three targeted repetitions and the final full suite passed.
- `npm run lint`: zero errors; 18 existing warnings in unchanged site files.
- `git diff --check`: passed.
