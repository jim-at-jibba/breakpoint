# Certificate trust is keyed on host and fingerprint

N7 asks for auto-trusted `localhost` and a one-time per-host prompt otherwise. Trust is
stored against the host **and** the certificate's SHA-256 fingerprint, not the host alone.

Loopback is auto-trusted only for self-signed and unknown-authority errors. An expired
certificate or a hostname mismatch on `localhost` indicates something other than a dev
server's cert, and still prompts.

## Consequences

Keyed on host alone, trusting a dev certificate today silently extends that trust to any
future certificate served on the same host — which on `localhost` is every project on the
machine, forever. Fingerprint keying means a changed certificate prompts again, which is
mildly annoying exactly when it should be.
