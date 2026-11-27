import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ConsoleBatch } from '../src/shared/console-feed'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Pane,
  type StoredProject
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { bundledPageFor, BUNDLED_SOURCES } from './bundle'
import { FLOOD, FLOOD_PATH, startFixture, type Fixture } from './fixture'
import {
  closeApp,
  launchApp,
  PATIENCE,
  requestLine,
  runCli,
  Sandbox,
  sendRaw,
  type LaunchedApp
} from './harness'

/**
 * Phase 2b's exit criterion, end to end against the real window (#82), in the two halves
 * the spec gives it, because the requirement has two.
 *
 * Rows: Phase 2a's fixture — a mobile-only exception from a minified bundle, and a
 * cross-origin failure at every width — drawn in the Console as rows, collapsed, each
 * carrying its panes' badges and the repo-relative location the log resolved. Collapsing
 * is asserted on the badges one row carries and never on how many rows there are: a view
 * that dropped entries and one that collapsed them draw the same number.
 *
 * Load: a page logging 2,000 entries in one second while the app is asked, over and over,
 * to answer a route, and every answer has to come back within a fixed deadline. "Without
 * jank" cannot be measured from outside the window and an unmeasurable criterion passes by
 * default ([ADR-0004]); a deadline on a round-trip can be, and it fails honestly when a
 * main thread is blocked. Asked twice: over the socket, which only the main process stands
 * between, and from the window, which the renderer's own main thread does too. And the
 * entries have to reach the window batched: one delivery per entry is the failure the
 * console's own channel exists to prevent, and it is counted rather than inferred.
 */

/** Where `e2e/bundled/src/nav.js` throws: the repo's file and line, not the bundle's. */
const THROWS = { path: 'src/nav.js', line: 3 } as const

/**
 * The longest any one round-trip may take while the page floods. A frame is 16ms; a
 * quarter of a second is a window that has visibly stopped answering. Scaled like every
 * other deadline in the harness, because a CI runner is slower at everything.
 */
const ROUND_TRIP_DEADLINE_MS = 250 * PATIENCE

/** How often a round-trip is started while the flood runs. */
const PROBE_EVERY_MS = 20

/**
 * The most deliveries the window may take to receive the flood. Batched per frame, a second
 * of logging is about sixty; one per entry is two thousand. A tenth of the entries is far
 * from both, so neither a slow frame nor a slow runner can push an honest run over it.
 */
const MOST_DELIVERIES = FLOOD.entries / 10

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repo: string
let fixture: Fixture

test.beforeEach(async () => {
  sandbox = new Sandbox()
  launched = undefined
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'bp-repo-')))
  fixture = await startFixture()
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repo, { recursive: true, force: true })
  await fixture.close()
})

function store(project: StoredProject): void {
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, projectFileName(repo)), JSON.stringify(writeProjectFile(project)))
}

async function open(): Promise<void> {
  const run = await runCli(sandbox, ['.', '--json'], repo)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
}

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

function rows(page: Page): Locator {
  return page.getByTestId('console-row')
}

/** The panes a row's badges name, in the order it draws them, the `+n` badge's included. */
async function badges(row: Locator, panes: readonly Pane[]): Promise<string[]> {
  const shown = await row
    .getByTestId('console-pane-badge')
    .evaluateAll((all) => all.map((badge) => (badge as HTMLElement).dataset.pane ?? ''))
  const more = row.getByTestId('console-more-badge')
  if ((await more.count()) === 0) return shown
  const named = (await more.getAttribute('title'))?.split(', ') ?? []
  expect(await more.textContent()).toBe(`+${named.length}`)
  return [...shown, ...named.map((name) => panes.find((pane) => pane.name === name)?.id ?? name)]
}

test('the mobile-only exception and the cross-origin failure are rows, collapsed, badged and located in the repo', async () => {
  test.setTimeout(120_000)

  const project: StoredProject = {
    ...createProject(repo),
    startUrl: `${fixture.a}${bundledPageFor('responsive')}`
  }
  store(project)
  // The repo the bundle was built from, so a resolved location has a file to point at.
  cpSync(BUNDLED_SOURCES, join(repo, 'src'), { recursive: true })
  const [mobile, ...wider] = project.panes
  const every = project.panes.map((pane) => pane.id)
  expect(project.panes.map((pane) => pane.width)).toEqual([390, 820, 1440])

  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await open()

  // Every pane has run the script at its own width before any row is judged, so a row
  // missing a pane is one that pane did not say, not one it has not said yet.
  await expect(rows(page).filter({ hasText: `laid out at ${mobile.width}px` })).toHaveCount(1)
  for (const pane of wider) {
    await expect(rows(page).filter({ hasText: `laid out at ${pane.width}px` })).toHaveCount(1)
  }

  // The exception: one row, the mobile pane's badge alone, at the line in the repo.
  const exception = rows(page).filter({
    hasText: `Uncaught RangeError: the nav does not fit in ${mobile.width}px`
  })
  await expect(exception).toHaveCount(1)
  await expect(exception).toHaveAttribute('data-level', 'error')
  expect(await badges(exception, project.panes)).toEqual([mobile.id])
  const location = exception.getByTestId('console-location')
  await expect(location).toHaveText(new RegExp(`^${THROWS.path}:${THROWS.line}:\\d+$`))
  await expect(location).toHaveAttribute('title', THROWS.path)
  // No wider pane threw, and none of them is hiding in a row of its own.
  await expect(rows(page).filter({ hasText: 'Uncaught RangeError' })).toHaveCount(1)

  // The cross-origin failure, the browser's two accounts of it, each one row carrying
  // every pane: three panes saying the same thing read as one thing said three times.
  const notShared = `${fixture.b}/not-shared`
  const network = rows(page).filter({ hasText: 'Failed to load resource: net::ERR_FAILED' })
  const refused = rows(page)
    .filter({ hasText: `'${notShared}'` })
    .filter({ hasNotText: 'Failed to load resource' })
  for (const row of [network, refused]) {
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-level', 'error')
    await expect(row).toHaveAttribute('data-panes', every.join(' '))
    expect(await badges(row, project.panes)).toEqual(every)
  }
  await expect(network.getByTestId('console-location')).toHaveText('not-shared')

  // Collapsed, not lost: opened, the network row is one line per pane, each its own, in
  // the order they arrived.
  await network.click()
  await expect(network).toHaveAttribute('aria-expanded', 'true')
  const copies = page.getByTestId('console-entry')
  await expect(copies).toHaveCount(project.panes.length)
  const opened = await copies
    .getByTestId('console-pane-badge')
    .evaluateAll((all) => all.map((badge) => (badge as HTMLElement).dataset.pane ?? ''))
  expect(opened.toSorted()).toEqual(every.toSorted())
})

test('2,000 entries in one second reach the window batched, and the app answers within a deadline throughout', async () => {
  test.setTimeout(120_000)

  // One pane, so the flood is 2,000 entries and not one per pane: a page at 2,000 a
  // second is the load §10 names, and one ring takes all of it.
  const base = createProject(repo)
  const project: StoredProject = {
    ...base,
    panes: base.panes.slice(0, 1),
    startUrl: `${fixture.a}/`
  }
  store(project)
  const [pane] = project.panes

  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await open()
  await expect
    .poll(async () => (await state()).panes[pane.id]?.attachment, { timeout: 20_000 })
    .toBe('attached')

  // Counted in the window, beside the console's own subscription, from before the page
  // loads: every delivery on either push channel, and how many flood entries each held.
  await page.evaluate(() => {
    const probe = { console: [] as number[], patches: 0 }
    ;(window as unknown as { probe: typeof probe }).probe = probe
    window.breakpoint.onConsole((batch: ConsoleBatch) => {
      probe.console.push(batch.entries.filter((entry) => entry.text.startsWith('flood ')).length)
    })
    window.breakpoint.onPatches(() => {
      probe.patches += 1
    })
  })

  const socketTrips: number[] = []
  const windowTrips: number[] = []
  let flooding = true
  const probes = (async () => {
    while (flooding) {
      const started = Date.now()
      const [socket, fromWindow] = await Promise.all([
        sendRaw(sandbox.socketPath, requestLine('panes.list')).then((response) => {
          expect(response.ok).toBe(true)
          return Date.now() - started
        }),
        page
          .evaluate(async () => (await window.breakpoint.invoke('panes.list')).ok)
          .then((ok) => {
            expect(ok).toBe(true)
            return Date.now() - started
          })
      ])
      socketTrips.push(socket)
      windowTrips.push(fromWindow)
      await new Promise((resolve) => setTimeout(resolve, PROBE_EVERY_MS))
    }
  })()

  const last = rows(page).filter({ hasText: `flood ${FLOOD.entries - 1}` })
  try {
    // From the window, as the address bar navigates: the allow-list binds automation only.
    const navigation = await page.evaluate(
      (url) => window.breakpoint.invoke('project.navigate', { url }),
      `${fixture.a}${FLOOD_PATH}`
    )
    expect(navigation.ok).toBe(true)

    // The page held the rate it was asked for, so this is the load and not a gentler one…
    const took = await inPane(page, pane.id, 'window.flooded')
    expect(took).toBeGreaterThanOrEqual(FLOOD.milliseconds * 0.9)
    expect(took).toBeLessThan(FLOOD.milliseconds * 1.5)

    // …and every entry reached the window, the newest of them drawn at the bottom.
    await expect(last).toBeVisible({ timeout: 10_000 * PATIENCE })
  } finally {
    flooding = false
    await probes
  }

  // Answered within the deadline from both sides, every time it was asked, and asked often
  // enough across the flood that a stall of the deadline's length could not fall between.
  expect(socketTrips.length).toBeGreaterThan(
    FLOOD.milliseconds / (ROUND_TRIP_DEADLINE_MS + PROBE_EVERY_MS)
  )
  expect(Math.max(...socketTrips), `socket round-trips: ${socketTrips.join(', ')}`).toBeLessThan(
    ROUND_TRIP_DEADLINE_MS
  )
  expect(Math.max(...windowTrips), `window round-trips: ${windowTrips.join(', ')}`).toBeLessThan(
    ROUND_TRIP_DEADLINE_MS
  )

  // Batched: the flood arrived in far fewer deliveries than it has entries, on the
  // console's channel and not as patches to the snapshot.
  const probe = await page.evaluate(
    () => (window as unknown as { probe: { console: number[]; patches: number } }).probe
  )
  const carrying = probe.console.filter((count) => count > 0)
  expect(carrying.reduce((sum, count) => sum + count, 0)).toBe(FLOOD.entries)
  expect(
    carrying.length,
    `deliveries carrying the flood, the largest ${Math.max(...carrying)} entries`
  ).toBeLessThan(MOST_DELIVERIES)
  expect(probe.patches, 'patch batches during the flood').toBeLessThan(MOST_DELIVERIES)
})

async function inPane(page: Page, pane: string, script: string): Promise<number> {
  const id = await page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
  return launched!.app.evaluate(
    ({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script),
    { id, script }
  )
}
