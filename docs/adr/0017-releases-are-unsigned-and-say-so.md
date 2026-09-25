# Releases are unsigned, and say so

Breakpoint publishes to GitHub Releases without an Apple Developer ID. The macOS artifacts
carry only the ad-hoc signature electron-builder falls back to, and every release tells the
user to run `xattr -dr com.apple.quarantine /Applications/Breakpoint.app` before the app
will open.

Signing and notarisation stay where PRD §11 puts them, in Phase 5. This decides that
packaging does not have to wait for them.

## Why an unsigned release is worth publishing at all

The alternative was no release until Phase 5, which is four phases and several weeks away.
Breakpoint's thesis is that a developer and their agent work the same panes, and that is
untestable by anyone who has to clone a repo and run `npm install` first. A build people can
download is what turns the thesis into feedback.

The friction is one command, run once per install, and it is a command a developer can read
and understand. That is a very different cost from asking someone to disable Gatekeeper, and
it is the cost we are choosing.

## What signing would buy, and what it costs

An Apple Developer ID is $99/yr and would remove the `xattr` step entirely: the app would
open on a double-click. Notarisation on top of it would also silence the first-run warning.

Neither is free beyond the fee. Notarisation adds a network round trip to every release
build, a stapling step, and a class of CI failure that only appears at release time — and
the certificate has to live in CI as a secret, be rotated, and be kept off pull-request
builds. That is a meaningful amount of machinery to stand up for a v0.1.0 that has no users
yet.

The trade reverses the moment there are enough users that the `xattr` step is generating
support load rather than being read as a pre-release signal. That is the trigger to revisit,
not a date.

## Consequences

**The instruction has to appear everywhere the download does.** The README, the Docs install
page and `.github/RELEASE_TEMPLATE.md` all carry it. A download link without the command
next to it is a bug, because a user who follows it gets an app that appears broken.

**Right-click → Open must never be documented.** Apple removed that bypass in macOS 15. The
only two routes are the `xattr` command and System Settings → Privacy & Security → Open
Anyway, and the latter only appears for about an hour after the block.

**`electron-builder.yml` carries no `publish` block.** That block is what makes
electron-builder write `Contents/Resources/app-update.yml` into the app; while there is no
updater, its only effect was shipping a placeholder URL to users. The release workflow
uploads artifacts with `gh release create` instead. Restore the block, pointed at GitHub, in
the same change that adds `electron-updater`.

Absence of that block is not enough on its own: on a tagged CI build electron-builder infers
the GitHub provider from the git remote and fails asking for a token, which is how the first
`v0.1.0-rc.1` run died on all three platforms at once. The `build:*` scripts pass
`--publish never` to say it outright. Keep that flag when the `publish` block comes back —
the workflow, not the builder, owns publishing.

**Windows and Linux artifacts are unsigned too**, and neither platform refuses to run them —
Windows SmartScreen warns rather than blocks. No separate decision is needed there.

## Why not ad-hoc sign the bundle ourselves

electron-builder already ad-hoc signs arm64 and universal builds, which is what satisfies the
kernel requirement that Apple silicon refuses to execute unsigned code. Re-signing the bundle
under our own identifier would change `Identifier=Electron` to `com.breakpoint.app` and seal
the bundle's resources, and it would change nothing a user sees: Gatekeeper's objection is to
the absence of an Apple-issued signature, not to the absence of any signature. It is work
that buys a tidier `codesign -dv` and nothing else.
