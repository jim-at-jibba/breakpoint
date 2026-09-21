# Project review fixes

Implement the five findings accepted by the request to fix the branch review:

- Ignore path-valued launch switches when selecting a repo, including separate values for supported path switches.
- Refuse a stored project whose repo identity differs from its storage key, leaving disk and current state untouched.
- Use asynchronous project filesystem operations and serialize opens in arrival order. A failed open must not poison the queue or publish state.
- Register macOS `open-file` handling before readiness, queue early requests, and dispatch them through `project.open` once the initial window and services are ready.
- Recover snapshot reads from rejected IPC promises and failed route envelopes. Retry with bounded backoff, expose a visible error and manual retry, discard patches while failed, and cancel timers/subscriptions on unmount.

Regression coverage includes launch switches, early and running-app native opens, identity mismatch, queued opens and write failure, retry exhaustion/recovery, and cleanup. Existing design tokens and the generated Button provide the error UI on app-owned chrome.

Unresolved questions: none.
