---
title: Install
description: Download Breakpoint, get past Gatekeeper, and put the CLI on your PATH.
---

Breakpoint is in pre-release: v0.1.0 is Phase 1 of 7. It is useful, and it is not finished.

<a href="https://github.com/jim-at-jibba/breakpoint/releases/latest" class="btn btn-primary" style="display: inline-block; margin: 1.5rem 0; font-size: 15px;">Download for macOS</a>

One universal build covers Apple silicon and Intel. Windows and Linux artifacts are on the
same page — see [Platform support](#platform-support) before you use them.

## Getting past Gatekeeper

Breakpoint is not code-signed yet, so macOS will refuse to open it. Move `Breakpoint.app`
to `/Applications`, then run:

```sh
xattr -dr com.apple.quarantine /Applications/Breakpoint.app
```

No `sudo`, once per install. The app then opens normally.

:::note[What that command does]
macOS tags downloaded files with a `com.apple.quarantine` attribute. Gatekeeper sees the
tag, finds no Apple-issued signature, and blocks the app. `xattr -dr` removes the tag — it
does not disable Gatekeeper or change any system setting.

The GUI alternative is **System Settings → Privacy & Security → Open Anyway**, which only
appears for about an hour after the app is blocked. Right-click → Open **no longer works**;
Apple removed that bypass in macOS 15.
:::

Signing and notarisation are Phase 5 work, deferred deliberately rather than forgotten.

## The `breakpoint` command

The CLI is the same binary as the app, so there is nothing separate to install. What there
is not yet is something that puts it on your `PATH` — "Install command line tool" is a
Phase 5 item. Until then, write the launcher yourself:

```sh
sudo tee /usr/local/bin/breakpoint >/dev/null <<'EOF'
#!/bin/sh
APP="/Applications/Breakpoint.app"
exec env ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Breakpoint" \
  "$APP/Contents/Resources/app.asar/out/main/cli.js" "$@"
EOF
sudo chmod +x /usr/local/bin/breakpoint
```

It runs the CLI under the app's own Electron runtime in Node mode, so it needs no separate
Node installation. Check it:

```sh
breakpoint --help
```

See the [CLI reference](/docs/cli/) for what the commands do, or the
[Quickstart](/docs/quickstart/) to get panes on screen.

## Platform support

| Platform | Status |
| --- | --- |
| **macOS 13+**, Apple silicon and Intel | Supported — this is where Breakpoint is developed and tested |
| **Windows** | Builds and runs; nobody has used it in anger |
| **Linux** (AppImage, deb) | Builds and runs; nobody has used it in anger |

Known defects on Windows and Linux:

- **The window has two title bars.** The frameless window is implemented for macOS only, so
  you get the native title bar *and* Breakpoint's toolbar, with an empty gap on the left
  where the macOS traffic lights would be.
- **There is no `breakpoint` launcher.** The snippet above is `/bin/sh`: adapt the paths for
  Linux, and on Windows call the CLI entry inside the install directory directly.

Both artifacts are published so they can be tried, not because they are ready. Issues from
either are welcome.

## Running from source

```sh
git clone https://github.com/jim-at-jibba/breakpoint.git
cd breakpoint
npm install
npm run dev
```

Requires **Node.js 22 or later** and **Git**. `npm run dev` starts the app with hot reload
for the renderer; the main process restarts on change.

A source checkout has its own launcher at `bin/breakpoint`, which resolves the repo it sits
in. Symlink it after `npm run build`:

```sh
npm run build
ln -s "$PWD/bin/breakpoint" /usr/local/bin/breakpoint
```

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks, then builds main, preload and renderer |
| `npm run build:mac` | Builds and packages a universal macOS app |
| `npm run build:win` | Builds and packages a Windows installer |
| `npm run build:linux` | Builds and packages AppImage and deb |
| `npm run build:unpack` | Builds an unpacked directory, useful for debugging packaging |
| `npm run typecheck` | Type-checks the node and web projects |
| `npm run test:unit` | Vitest, over the shared module both processes import |
| `npm run test:e2e` | Builds, then Playwright launches the real app and drives it with the CLI |
| `npm test` | Both |
| `npm run lint` | ESLint across the repo |
| `npm run format` | Prettier across the repo |
