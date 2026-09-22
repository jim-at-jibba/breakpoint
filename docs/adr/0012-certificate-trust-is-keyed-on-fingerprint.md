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

### The error Chromium reports is not enough to apply this

Chromium collapses a certificate's several faults into one net error, and reports the
unreachable authority ahead of both an expired certificate and a mismatched name. A
self-signed certificate that has expired therefore arrives as
`net::ERR_CERT_AUTHORITY_INVALID`, indistinguishable from the dev certificate loopback is
allowed to trust. There is also no separate self-signed code: self-signed and
unknown-authority are that one error.

So the loopback rule reads the certificate itself for the two things it turns on —
whether it names the host it was served for, and whether now is inside its dates — and
uses the error only to check that the failure is the unreachable-authority one. Trusting
the error string alone would auto-trust exactly the two cases this ADR says must prompt.

### Trust is the app's, not a project's

A certificate belongs to a host and this machine, so the decisions are one global file
beside `presets.json` rather than something a project carries, and they are in the state
snapshot next to `project` rather than inside it. Two projects on one staging server are
one decision, and closing a project does not forget it.

### A refusal is remembered for the run, and only for the run

Panes do not all reach the certificate at the same instant. Answering "no" for the pane
that got there first and then asking again for each of the others is the same question
three times, so a refusal is held in memory against the same key and answers the rest.
Nothing is written to disk: the next Navigation clears it — Navigation in `CONTEXT.md`'s
sense, every pane pointed at one URL, which a pane following a link inside itself is not.
Deliberately going there again is the way to be asked again.
