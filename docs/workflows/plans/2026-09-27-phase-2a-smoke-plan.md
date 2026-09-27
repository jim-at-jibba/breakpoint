# Phase 2a manual smoke — #50, #51, #52

Run once, after #52 lands. Complements the automated suite; it does not replace it — #57 is
the exit gate.

## Why this exists

The fixture is synthetic. ADR-0020 says as much: a fixture shaped only like a dev server
proves the arithmetic and ships the fetch path untested, "with the first real webpack
project as its test". Everything below runs the pipeline against a real Astro dev server
and a real production build — neither of which we authored to be resolvable.

#47 is also open (a different handful of e2e specs fails every run), so "CI was green" is
weaker evidence than usual while it stands.

## What this does NOT retest

Automated coverage owns these, and a human cannot force them by hand:

- the attach retry after `did-stop-loading`, and replay surviving the second attempt
- a pane whose attachment failed staying degraded and silent
- read-time truncation limits for text, previews and stacks
- entry decoding as a pure function

What manual adds is the four things a fixture cannot fake: real script URLs, real source
maps, real message volume, and real resolution timing.

---

## Pre-flight

1. **Check the lock.** The user-data lock is shared across worktrees. If another
   worktree's app is running, a launch here exits 0 silently and you debug a ghost.
   Quit any running instance first and expect exit 3 if none is up:
   ```
   ./bin/breakpoint quit    # exit 3 = nothing was running, which is what you want
   ```
2. **Build**, so `out/` matches the branch you are testing:
   ```
   npm run build
   ```
3. **Start the site's dev server** in a second terminal, and **read the port out of its
   output** rather than assuming one. Astro's dev server is managed, so `npm run dev` may
   report an instance already running on a port of its own — 3000, not 4321, on the run
   this plan was written against. Every URL below says `<dev-port>`; substitute it.
   ```
   cd sites/web && npm run dev
   ```

Throughout, `./bin/breakpoint` is the development launcher; use plain `breakpoint` if it
is on your PATH.

---

## The scratch page

Create `sites/web/src/pages/smoke.astro`. **Delete it when you are done.** It is not a
docs page, so the CLI reference drift check is unaffected by it.

**The viewport meta is load-bearing, not boilerplate.** Without it Chromium falls back to a
980px layout viewport, so `window.innerWidth` reads 980 in the Mobile and Tablet panes
whatever their emulation says, the width-conditional throw never fires, and A6 fails for a
reason that has nothing to do with the console pipeline. That is the Phase 0 failure shape
exactly — a check that looks like a verdict on the code and is not. With the meta present
the three panes report 390, 820 and 1440, which is also the cheapest confirmation that
emulation is taking at all.

Two kinds of script on purpose. `is:inline` stays in the HTML document, so its location is
the page URL — probably unresolvable, which exercises the honest-failure path. The plain
`<script>` is processed by Astro and served by Vite as a module with a real source map,
which is the genuine dev-server-shaped case.

```astro
---
---
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>smoke</title>
<script is:inline>
  // Runs before anything else: exercises Runtime's replay of buffered messages.
  console.log('smoke: first line, before app scripts');
</script>
</head>
<body>
<h1>smoke</h1>
<script>
  const sample = { width: window.innerWidth, nested: { a: 1, b: [1, 2, 3] } };
  console.debug('smoke debug', sample);
  console.log('smoke log', sample);
  console.info('smoke info', sample);
  console.warn('smoke warn', sample);
  console.error('smoke error', sample);

  // A cross-origin fetch the browser refuses: arrives as a browser message, not an
  // exception, and with no Network domain enabled.
  fetch('https://example.com/cors-please').catch(() => {});

  Promise.reject(new Error('smoke: unhandled rejection'));

  // Fires in the Mobile pane (390) and in neither Tablet (820) nor Desktop (1440).
  if (window.innerWidth < 500) {
    setTimeout(() => {
      throw new Error('smoke: mobile-only failure at ' + window.innerWidth);
    }, 0);
  }

  // Volume, only when asked for.
  if (new URLSearchParams(location.search).has('volume')) {
    for (let i = 0; i < 2000; i += 1) console.log('smoke volume', i);
  }
</script>
</body>
</html>
```

## Open it

**Open the repo as a project. Do not reach for `breakpoint open <url>` first.** A project
opened from a URL is repo-less by design (ADR-0015): its `repoPath` is null, so *nothing
can resolve* and every location in section B comes back `failed`. That is correct
behaviour, and it will read exactly like a broken resolver. Open the directory the dev
server serves, so the repo-relative paths B1 asserts have a repo to be relative to:

```
./bin/breakpoint sites/web --wait
./bin/breakpoint state --json | jq '{repoPath: .project.repoPath, cursor}'
```

`repoPath` must be non-null before you go on. The project may also remember a `startUrl`
from a previous session and time out reaching it; that is harmless here.

**Then let automation navigate to the dev server.** A project's origin allow-list gates
this, and `ORIGIN_NOT_ALLOWED` is what you get otherwise. There is no CLI command for it
in this phase, so it goes over the local socket — which is also a free check that a
route without a command is reachable (ADR-0025):

```
node -e 'const{connect}=require("net"),{homedir}=require("os");
const s=connect(`${homedir()}/Library/Application Support/Breakpoint/breakpoint.sock`);
s.on("connect",()=>s.write(JSON.stringify({id:"x",route:"project.setAllowedOrigins",
params:{origins:["http://localhost:<dev-port>"]}})+"\n"));
s.on("data",d=>{console.log(String(d).trim());s.destroy()})'

./bin/breakpoint open http://localhost:<dev-port>/smoke --wait
./bin/breakpoint state --json | jq '{cursor, panes: [.project.panes[] | {id, name, width, height}]}'
```

The project opens with Mobile 390×844, Tablet 820×1180 and Desktop 1440×900. Note the
cursor — several checks below read from it. Note also that the allow-list is kept with the
project and survives a restart, so this edit outlives the smoke; see tear-down.

Note: `--errors`, `--pane` and `--level` do not exist yet (they are #54), so every filter
below is `jq`.

---

## A. Capture (#50)

**A1 — every pane is represented.** The failure this catches is the one that matters:
a pane reporting nothing reads exactly like a clean pane.

```
./bin/breakpoint logs --json | jq '[.entries[] | select(.type | startswith("console.")) | .pane] | unique | length'
```
- Pass: `3`.
- Fail: `2` or fewer. Cross-check against the pane ids from `state` to see which one is
  missing, and whether its status is degraded or merely quiet.

**A2 — all five levels arrive, with argument previews.**

```
./bin/breakpoint logs --json | jq '[.entries[] | select(.type=="console.message" and .source=="console") | .level] | group_by(.) | map({(.[0]): length}) | add'
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.message" and (.text|test("smoke log"))) | .args'
```
- Pass: each of debug/log/info/warn/error appears 3 times (once per pane), and `args`
  holds a preview per argument in which the nested object is still legible.
- Fail: a level missing, or previews that are empty braces. Empty braces here are the
  C8 failure — a preview that means nothing once the page has moved on.

**A3 — the replay.** The inline first line is logged before the page's own scripts run.

```
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.message" and (.text|test("first line"))) | "\(.pane[0:8])  \(.text)"'
```
- Pass: three rows, one per pane.
- Fail: fewer than three, or none. This is the one thing `Runtime.enable`'s replay buys;
  nothing else satisfies C1.

**A4 — the browser's own message.** Should arrive with a source, with no `Network`
domain enabled.

```
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.message" and .source!="console") | "\(.source)  \(.level)  \(.url // "-")  \(.text)"'
```
- Pass: a `network` or `security`-sourced error naming `example.com`, per pane.
- Fail: absent — meaning `Log` is not enabled or its entries are being dropped.

**A5 — exceptions and rejections.**

```
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.exception") | "\(.pane[0:8])  rejection=\(.rejection)  \(.text)"'
```
- Pass: an unhandled rejection for all three panes with `rejection=true`, and the
  mobile-only throw with `rejection=false`.
- Fail: rejections reported as ordinary messages, or `rejection` always false.

**A6 — the width-conditional throw is width-conditional.**

```
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.exception" and (.text|test("mobile-only"))) | .pane'
```
- Pass: exactly one pane id, and it matches the 390-wide pane from `state`.
- Fail: three panes (emulation is not taking) or zero (the pane is not reporting).
  Either way this is the phase's whole premise, so stop and investigate.

**A7 — previews survive navigation.** Handles expire; previews must not.

```
./bin/breakpoint open http://localhost:<dev-port>/ --wait
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.message" and (.text|test("smoke log"))) | .args'
```
- Pass: identical to what A2 printed.
- Fail: empty or altered. Then navigate back to `/smoke` before continuing.

**A8 — volume.** §12 item 8's risk, with three panes rather than six.

```
./bin/breakpoint state --json | jq .cursor        # note this as $C
./bin/breakpoint open 'http://localhost:<dev-port>/smoke?volume=1' --wait
./bin/breakpoint logs --since $C --json | jq '{returned: (.entries|length), cursor, droppedBefore}'
```
- Pass: the window stays responsive, the read returns at most 1000 entries, and `cursor`
  comes back short of the head so a second read continues from it. Repeat the read from
  the returned cursor until it catches up.
- Fail: the app stalls, the read never terminates, or `cursor` does not advance.
- Also worth watching: whether 6000 entries across three panes evict anything
  (`droppedBefore` present). At 10,000 per pane it should not.

---

## B. Resolution (#51)

**B1 — the processed script resolves to a repo path.** This is the check the fixture
cannot make for you.

```
./bin/breakpoint logs --json | jq -r '[.entries[] | select(.type|startswith("console.")) | [(.location // empty)] + (.stack // []) | .[] | select(.resolution=="resolved") | "\(.path):\(.line)"] | unique[]'
```
- Pass: paths that are repo-relative and that name `sites/web/src/pages/smoke.astro`.
  **Open the file at the reported line and confirm it is the right statement** — a path
  that resolves to the wrong line is worse than one that does not resolve, because it
  sends an agent to edit the wrong thing.
- Fail: nothing resolved, or paths that are still Vite URLs with `?t=` cache-busting
  query strings on them. The latter is the likely shape of a real bug here.
- **Known, and tracked as #61:** code written in an Astro `<script>` block resolves to the
  right file and the wrong line, because the map names a virtual module
  (`smoke.astro?astro&type=script&index=0&lang.ts`) whose coordinates belong to the
  extracted script. A real `.ts` file in the same map resolves exactly. Until #61 lands,
  check B1's lines against a source that is a genuine file, and expect the `.astro` lines
  to be wrong — do not read that as a regression in #51 or #52.

**B2 — stack frames, not just the entry's own location.**

```
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.exception" and (.text|test("mobile-only"))) | .stack[] | "\(.function // "(top level)")  \(.path // .url):\(.line)"'
```
- Pass: at least the throwing frame carries a repo-relative path.
- Fail: frames present but all unresolved while the entry's own location resolved —
  resolution is being applied in one place and not the other.

**B3 — honest failure.** The inline script's location is probably unresolvable. That is
fine; what matters is that it says so.

```
./bin/breakpoint logs --json | jq -r '.entries[] | select(.type=="console.message" and (.text|test("first line"))) | .location'
```
- Pass: `resolution` is `"failed"` and `path` is `null`, with `url`, `line` and `column`
  exactly as the page reported them. Or it resolves — also fine.
- Fail: `resolution` says `resolved` with a `path` that does not exist on disk, or the
  location is missing altogether.

**B4 — the resolution rate, across the whole run.** This is the number the spec asks you
to watch.

```
./bin/breakpoint logs --json | jq '[.entries[] | select(.type|startswith("console.")) | [(.location // empty)] + (.stack // []) | .[] | .resolution] | group_by(.) | map({(.[0]): length}) | add'
```
- Pass: the great majority resolved, with failures confined to the inline script.
- **If a noticeable share of the processed script's locations come back `failed`, that is
  the signal.** Per the spec, the answer is a warm cache, not a move to read time —
  read time was rejected on a fact about dev servers, not on cost. Record the ratio
  before deciding anything.

**B5 — a project with no repo path.** Unresolved must be ordinary, never an error.

```
./bin/breakpoint open https://example.com --wait
./bin/breakpoint logs --json | jq '[.entries[] | select(.type|startswith("console.")) | .location | select(. != null) | .resolution] | unique'
```
- Pass: `["failed"]`, the log keeps working, and nothing raises.
- Fail: an error entry, a thrown route, or a pane going degraded because of it.

**B6 — timing.** Resolution sits on the append path, and the timeout is what keeps that
honest.

- Watch the entries appear as the page loads. Ordering should reflect what happened.
- Pass: no perceptible lag between the page settling and the log being complete.
- Fail: entries trickling in seconds late, or arriving out of order relative to the
  lifecycle entries around them.

---

## C. Source maps (#52)

Confirm the specifics against the landed ticket before running this section — the fixture's
bundler and the dependency it chose are decided in #52, not here.

**A stock `astro build` tests none of this, and does not say so.** Two defaults defeat it:
`build.sourcemap` is off, so there is no map to fetch; and a small `<script>` is minified
straight into the HTML document, so there is no external script either. Point Breakpoint at
that build and every location fails — which is C2's pass, not C1's, and the two are easy to
confuse. Make the build actually bundle, and actually carry maps, before C1 means anything:

1. In `sites/web/astro.config.mjs`, temporarily add
   `build: { sourcemap: true }` and `vite: { build: { sourcemap: true, assetsInlineLimit: 0 } }`.
2. Give the scratch page's script a real import, so it becomes its own chunk rather than
   being inlined. A one-function scratch module beside the page does it, and it earns its
   keep twice over: it is a genuine file, where the `.astro` script is a virtual module, so
   the two resolve differently in the same map and the contrast is the point.
3. Rebuild and confirm before opening anything:
   ```
   cd sites/web && npm run build
   find dist -name '*.map' | head          # must be non-empty
   grep -o 'src="/_astro/[^"]*"' dist/smoke/index.html   # must list the script's own chunk
   ```

Both edits are temporary. Tear-down reverts them.

**C1 — a real production build resolves.**

```
cd sites/web && npx astro preview --port 4321
# allow the preview origin the same way you allowed the dev server's, then:
./bin/breakpoint open http://localhost:4321/smoke --wait
```
Then repeat B1 and B2 against it.
- Pass: the bundled, minified script's frames still resolve to `.astro`/`.ts` sources
  with plausible lines. Open one and check.
- Fail: everything `failed`. That means arithmetic found nothing and the fetch path did
  not pick it up — exactly the case the fixture was built to avoid shipping untested.

**C2 — a missing map fails honestly and on time.** Move or rename the `.map` beside the
built script, reload, and repeat B3's shape of check.
- Pass: entries append promptly with raw locations and `resolution: "failed"`.
- Fail: entries delayed, missing, or claiming a path.

**C3 — the dependency is declared.**
```
jq '.dependencies' package.json
```
- Pass: the source-map library appears as a direct dependency, not only transitively in
  the lockfile.

---

## D. Cross-cutting

**D1 — incremental reads.** What an agent actually does after an edit.

```
./bin/breakpoint state --json | jq .cursor      # $C
# edit smoke.astro so a console.error message changes, save, let the dev server reload
./bin/breakpoint logs --since $C --json | jq -r '.entries[] | "\(.cursor)  \(.type)  \(.text // "")"'
```
- Pass: the new entries and the reload's navigation entries, and nothing from before `$C`.
- Fail: entries repeated from before the cursor, or the reload producing nothing.

**D2 — nothing in the log that stops being true.** ADR-0021.

```
./bin/breakpoint logs --json | grep -ci 'objectid'
```
- Pass: `0`.
- Fail: anything above zero — a handle has leaked into a frozen entry.

---

## Tear-down

1. Delete `sites/web/src/pages/smoke.astro` and the scratch module section C added beside it.
2. Revert `sites/web/astro.config.mjs` — keep a copy before editing it, and diff at the end.
3. Restore the project's origin allow-list. It is kept with the project, so the entry added
   in "Open it" survives a restart; `project.setAllowedOrigins` **replaces** the list rather
   than adding to it, so capture the original from `state` *before* setting it, or you
   cannot put it back.
4. `./bin/breakpoint quit`.
5. Stop the preview server. Leave the dev server if it was already running when you started.
6. `git status --short` must show nothing but this plan.

## What the first run found

Run 2026-09-27, against #50, #51 and #52 at `f43c8c5`. Every check passed except B1.

- **A** all pass. Volume: 6,041 entries, reads cap at 1,000, the cursor advances and
  terminates, nothing evicted, a `state` call 90ms afterwards.
- **B** resolution works. Dev server 38 of 92 locations resolved; production build 57 of 63.
  Every failure was a genuine non-repo URL — Vite virtual modules and the HTML document —
  so the honest-failure path is doing its job. B1 is the exception, now #61.
- **C** all pass, once the build was made to bundle and carry maps. The minified chunk
  resolved through its fetched map into two different source files, and the real `.ts`
  file's lines were exact.
- **D** all pass; no handle has leaked into a stored entry.

Two observations worth keeping, neither a defect in this phase:

- The Mobile pane loads twice on open, ~73ms apart, with two genuine `pane.loaded` entries.
  Capture handles it correctly; whether the reload should happen at all is a separate question.
- A browser message arrives twice for one refused cross-origin fetch — once `javascript`
  -sourced (the CORS text) and once `network`-sourced (`ERR_FAILED`). Both are real
  `Log` entries, so this is faithful rather than duplicated.

## Recording the result

Worth a comment on #57 either way: the resolution ratio from B4, whether B1's lines were
right, and anything B6 showed about timing. If B4 is poor, that is an issue of its own
against the warm cache rather than a reason to reopen any of #50–#52.
