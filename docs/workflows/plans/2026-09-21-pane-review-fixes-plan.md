# Pane review fixes plan

1. Retain the last live snapshot in the snapshot reader across fetching/error states. Keep the canvas mounted and render refresh/error status independently in the toolbar. Add unit and real-guest recovery regressions.
2. Convert pane lifecycle APIs and host call sites to named parameter objects. Check own-key membership in geometry reports and cover missing/prototype ids over the route boundary.
3. Add a shared HTTP(S) URL predicate and enforce it when parsing project files and attaching guests. Harden guest preferences and install session permission handlers before loading. Guard page navigation, redirects, and programmatic loads, verifying Electron 44 behavior with real guests.
4. Extend security integration coverage for hostile web preferences/CORS, permission checks and requests on multiple sessions, initial and subsequent invalid schemes, and allowed cross-origin navigation/resources.
5. Run unit tests, build/typechecks, Electron integration tests, lint, and `git diff --check`; inspect the completed diff against all eight findings.

Unresolved questions: none.

## Electron navigation boundary

Electron 44 routes `webview.src` and `webview.loadURL` through the guest's main-side `loadURL` method, without emitting `will-navigate`. Guard that method per guest before the first load, plus cancellable page-navigation and redirect events. Synchronous `stop()` from `did-start-navigation` crashed the real app in regression tests; deferred cancellation could let a document commit and is not used.

Chromium can create an empty `about:blank` document from page code without emitting `will-navigate`; that internal blank-document transition is outside this event guard. Explicit `about:` sources and programmatic loads are rejected. The page-navigation regression uses a real blob document, while separate checks retain ordinary data/blob subresources.

## Verification

- All eight review findings addressed, with 20 added unit cases and 9 added Electron integration tests.
- `npm run test:unit`: 238 passed.
- `npm run build`: production build and both TypeScript checks passed.
- Final `npx playwright test`: 60 passed.
- `npm run lint`: zero errors; 18 existing formatting warnings in unchanged site files.
- `git diff --check`: passed.
- Real Electron checks cover CORS enforcement, secure mixed-content preferences, permission checks/requests across shared and isolated sessions, initial sources, programmatic URL loads, page navigation, redirects, embedded resources, prototype-key route inputs, and guest/form/history preservation through snapshot recovery.
