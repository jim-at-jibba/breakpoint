# Event log review fixes

Implement the four findings accepted by the request to fix the branch review:

- Bound log reads by serialized UTF-8 bytes as well as entry count. Reserve response-envelope space, including a bounded JSON-encoded request id. Shorten oversized text fields at read time with explicit field markers, retaining the original stored entry and a usable continuation cursor.
- Freeze stored entries and expose readonly records and read results so callers cannot rewrite history.
- Preserve recognized CLI flags when a value flag is missing its value, including JSON error output.
- Replace arbitrary parameter keys and assertions with command-specific parsers checked against their declared route signatures.

Regression coverage includes multibyte and escaped text, oversized individual failures, pagination over the real socket, immutable history, JSON errors on missing values, and compile-time route parameter checks. Update the public log contract and ADR.

Unresolved questions: none.
