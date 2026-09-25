# macOS ships one universal artifact

`electron-builder.yml` pins the macOS dmg and zip targets to `arch: [universal]`. There is
no separate arm64 build and no separate x64 build.

## Why not two per-arch builds

Two builds are the obvious choice: half the download size each, and users only fetch the
slice they need. It does not survive contact with unsigned distribution.

electron-builder falls back to an ad-hoc signature only when the architecture is `arm64` or
`universal` — there is no fallback for `x64`. Apple silicon refuses to execute code with no
signature at all, so the fallback is not a nicety: it is what makes the artifact runnable.
A cross-built x64 slice gets no signature, and macOS reports unsigned and
signature-broken code with the same message — *"is damaged and can't be opened"* — which
reads as a corrupted download rather than as a Gatekeeper decision. The `xattr` command in
[ADR-0017](0017-releases-are-unsigned-and-say-so.md) does not fix it.

Building the x64 slice on a genuinely x64 machine would avoid this, but GitHub's
`macos-latest` runner is arm64, and the x64 images are billed at a premium. Paying per
release to produce a second artifact that exists only to be smaller is the wrong trade at
v0.1.0.

## Consequences

**The download is roughly 217MB rather than 122MB.** Two full Electron runtimes in one file.
This is the whole cost of the decision and it is a real one — it is the first thing to
revisit if download size ever becomes a complaint.

**One download button, one filename, one set of instructions.** The Site links to a single
artifact and the README's `xattr` command is correct for every Mac. A per-arch split would
put an "which chip do I have?" question in front of a first-time user, which is its own cost
and is usually undercounted.

**Artifact names carry `${arch}`** — `Breakpoint-0.1.0-universal.dmg`. They did not before:
`dmg.artifactName` was `${name}-${version}.${ext}`, which produces the same filename for
every architecture. That was harmless while only one arch was ever built and would have
silently overwritten one artifact with another the first time two were.

## When to reverse this

Buy a Developer ID, and the reasoning collapses — signed x64 builds need no fallback, and
per-arch artifacts become free to produce. So this decision is downstream of
[ADR-0017](0017-releases-are-unsigned-and-say-so.md) and should be reconsidered in the same
change that resolves it, not independently.
