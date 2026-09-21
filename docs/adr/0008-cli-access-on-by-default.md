# CLI access is on by default

§14 open question 6 proposed CLI access off by default, with a one-time prompt, on the
grounds that any same-user process could otherwise read console output. It is on by default.

A same-user process can already read `userData` directly — the project files, the cookie
store, the session data. A unix domain socket in that same directory does not widen the
boundary; it only makes what is already reachable convenient. Meanwhile off-by-default makes
U12's zero-configuration promise false and guarantees that an agent's first command fails.

## Consequences

This overrides an explicit PRD position, so it is the decision most worth revisiting. It is
sound specifically because Phase 1's socket exposes observation and navigation only. When act
commands land in Phase 6 the stakes change, and the default should be re-argued then rather
than inherited.
