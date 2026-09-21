# Wire review fixes

Implement the seven findings from the branch review:

- Explicit dispatch signatures without the redundant route-entry assertion.
- Bound newline-delimited request and response frames to 1 MiB of UTF-8, excluding the newline. Reject oversized frames and close their connection. Buffer fragments without rescanning previous input.
- Catch startup failures after readiness, log context and exit nonzero.
- Preserve stable codes in all CLI errors, with structured stderr diagnostics in JSON mode and payload-only stdout.
- Pin integration-test socket paths regardless of inherited environment overrides.
- Validate response error codes against the declared set.
- Preserve route-specific payload types through the preload bridge while leaving raw transport responses unvalidated at the type level.

Verification covers frame boundaries, split and multibyte input, oversized clients and replies, startup failure, CLI error output, sandbox isolation and bridge typing. Run unit tests, Electron integration tests, build/typechecks and lint.

Unresolved questions: none.
