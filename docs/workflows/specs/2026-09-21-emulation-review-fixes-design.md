# Emulation review fixes

The user approved all five PR-review findings for implementation.

## Design

- Start the guest renderer with a host-owned blank document, then hold the first target `loadURL` until its first attachment/emulation attempt settles. CDP cannot answer before a renderer exists. HTTP(S) validation runs before this internal bootstrap; blank lifecycle events are not page observations, and its history entry is removed on the first target commit. A failed attachment or override still permits the page to render with its degraded status; the existing one-time attachment retry remains after the target load.
- Invalidate only capabilities affected by saved setting changes: DPR affects viewport; mobile affects viewport, user agent and touch; colour scheme affects colour scheme. Publish the pending status before announcing the new pane declaration. Both surfaces consume the same status patch. Keep existing degradation reasons until a new result resolves them, including recovery entries.
- Preserve the host's latest-pass guard so obsolete CDP answers cannot complete a newer setting change.
- Replace the loose command record with a discriminated union tying capability, CDP method and parameter types together. Pass the user-agent helper a named options object.
- Cover failed saves, delayed saves, concurrent settings, and settings interleaved with project opens using real project storage and controlled save failures/delays.

## Acceptance

The first target document observes touch support during its own initialisation, without a reload or duplicate document request. Changed capabilities remain pending until the current application completes. Unaffected capabilities stay applied. Failed saves leave disk, state and announcements unchanged, and the queue continues after rejection. Invalid command combinations fail typechecking.

Unresolved questions: none.
