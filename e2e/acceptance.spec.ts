import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type ColorScheme,
  type Pane,
  type Project
} from '../src/shared/project'
import { snapshotReadiness as readiness, type StateSnapshot } from '../src/shared/state'
import { HIT_TARGET, SCHEME_SWATCH, startFixture, SWATCH, type Fixture } from './fixture'
import {
  closeApp,
  launchApp,
  requestLine,
  runCli,
  Sandbox,
  sendRaw,
  type LaunchedApp
} from './harness'

/**
 * Phase 1's exit criterion, end to end, in the form the Phase 0 failure forced (#20,
 * [ADR-0004]): three panes render a localhost fixture at 50% canvas zoom, and that is
 * shown by what is on screen rather than by what CDP says.
 *
 * The original criterion — `innerWidth` reads the declared width — passed for three full
 * probe runs while every pane was 150px tall. So every claim here about a pane rendering
 * is made from outside the page's account of itself: the element's measured box on the
 * host, a click near its bottom edge landing, the image variant the server was asked for,
 * and the pixels of a swatch. The test then collapses a pane's element and shows that
 * those checks catch it while CDP still reports the declared viewport.
 *
 * The click is the one that cannot be skipped. Phase 0's actual bug, `display: block` on
 * the `<webview>`, leaves the element at its declared size and collapses only the guest
 * inside it: measured by hand, the drawn size and the app's own geometry check both pass
 * with it in, and the bottom-edge click is what fails.
 */

const ZOOM = 50

/** Explicit, and not all one value, so that a restart that dropped them would show. */
const SCHEMES: readonly Exclude<ColorScheme, 'system'>[] = ['dark', 'light', 'dark']

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repo: string
let fixture: Fixture

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

/** `breakpoint . --wait --json` from the repo, as an agent would run it: one payload, ready. */
async function openAndWait(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['.', '--wait', '--json'], repo)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(run.stdout.trimEnd().split('\n')).toHaveLength(1)
  const snapshot = JSON.parse(run.stdout) as StateSnapshot
  expect(readiness(snapshot)).toEqual({ ready: true })
  return snapshot
}

async function route(name: string, params: unknown): Promise<void> {
  expect(await sendRaw(sandbox.socketPath, requestLine(name, params))).toMatchObject({ ok: true })
}

function webview(page: Page, pane: string): ReturnType<Page['locator']> {
  return page.locator(`webview[data-pane="${pane}"]`)
}

/**
 * The pane's whole drawn area brought on screen. The pane's frame rather than its
 * `<webview>`, because the frame keeps its declared size when the element inside it is
 * collapsed, and the declared bottom edge is exactly the place a click has to reach.
 */
async function reveal(page: Page, pane: string): Promise<void> {
  await page
    .locator(`[data-testid="pane"][data-pane="${pane}"]`)
    .evaluate((element) => element.scrollIntoView({ block: 'end', inline: 'nearest' }))
}

/** The `<webview>`'s own rendered box, in the host's screen pixels. Asks the guest nothing. */
function drawnBox(page: Page, pane: string): Promise<Box> {
  return webview(page, pane).evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
}

function guestId(page: Page, pane: string): Promise<number> {
  return webview(page, pane).evaluate((element) =>
    (element as unknown as { getWebContentsId(): number }).getWebContentsId()
  )
}

function inGuest<T>(id: number, script: string): Promise<T> {
  return launched!.app.evaluate(
    ({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script),
    { id, script }
  ) as Promise<T>
}

/**
 * Whether a click a few screen pixels inside the pane's declared bottom-left corner lands
 * on the page's bottom-left target. Aimed at where the pane claims its bottom is, not at
 * where its element measures, so a pane shorter than it claims is a miss.
 *
 * Dispatched by Playwright's mouse, which is CDP `Input.dispatchMouseEvent` on the host
 * window's own session: the host's `sendInputEvent` does not reach a guest. Retried until
 * `timeout`, because a guest's hit-test regions follow a host scroll a frame or so late;
 * a pane that is not drawn where it claims is never hit however often it is clicked.
 */
async function hitsBottomEdge(page: Page, pane: Pane, timeout: number): Promise<boolean> {
  const id = await guestId(page, pane.id)
  const hits = (): Promise<number> =>
    inGuest<string>(id, `document.getElementById('target').dataset.hits`).then(Number)
  const before = await hits()
  const deadline = Date.now() + timeout
  do {
    const box = await drawnBox(page, pane.id)
    // HIT_TARGET CSS px is half that on screen at 50%; aim well inside it.
    const inset = (HIT_TARGET * ZOOM) / 100 / 4
    const bottom = box.y + (pane.height * ZOOM) / 100
    await page.mouse.click(box.x + inset, bottom - inset)
    if ((await hits()) > before) return true
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return false
}

/**
 * The centre pixel of the pane's scheme swatch, read off the host window's composited
 * raster — what is on the developer's screen — rather than asked of the page.
 */
async function swatchColour(page: Page, pane: string): Promise<number[]> {
  const box = await drawnBox(page, pane)
  const size = (SWATCH * ZOOM) / 100
  const rect = {
    x: Math.round(box.x + box.width - size),
    y: Math.round(box.y),
    width: Math.round(size),
    height: Math.round(size)
  }
  return launched!.app.evaluate(async ({ BrowserWindow }, rect) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())!
    const image = await window.webContents.capturePage(rect)
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
    // BGRA on every platform Electron ships.
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
  }, rect)
}

function assetsRequested(since: number): string[] {
  return fixture
    .requests()
    .slice(since)
    .filter((request) => request.url.startsWith('/asset'))
    .map((request) => request.url)
    .sort()
}

test.beforeAll(async () => {
  fixture = await startFixture()
})

test.afterAll(async () => {
  await fixture.close()
})

test.beforeEach(() => {
  sandbox = new Sandbox()
  launched = undefined
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'bp-repo-')))
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repo, { recursive: true, force: true })
})

test('three panes render localhost at 50%, drawn, clickable to the bottom edge, and restored', async () => {
  test.setTimeout(180_000)

  // Stored at a layout and zoom other than the ones under test, so that finding them at
  // 50% Horizontal after the restart can only mean the app wrote them.
  const stored: Project = {
    ...createProject(repo),
    startUrl: `${fixture.a}/`,
    allowedOrigins: [fixture.a],
    layout: 'focus',
    zoom: 100
  }
  mkdirSync(join(sandbox.userDataDir, 'projects'), { recursive: true })
  writeFileSync(
    join(sandbox.userDataDir, 'projects', projectFileName(repo)),
    JSON.stringify(writeProjectFile(stored))
  )
  expect(stored.panes.map((pane) => pane.name)).toEqual(['Mobile', 'Tablet', 'Desktop'])

  // --- `breakpoint . --wait --json` prints the pane set --------------------------------
  launched = await launchApp(sandbox)
  const first = await openAndWait()
  expect(first.project?.repoPath).toBe(repo)
  expect(first.project?.panes).toEqual(stored.panes)
  expect(Object.keys(first.panes).sort()).toEqual(stored.panes.map((pane) => pane.id).sort())

  // --- The developer's changes, made through the same routes every surface uses --------
  await route('project.setLayout', { layout: 'horizontal' })
  await route('project.setZoom', { zoom: ZOOM })
  for (const [index, pane] of stored.panes.entries()) {
    await route('panes.setEmulation', { pane: pane.id, colorScheme: SCHEMES[index] })
  }
  await expect
    .poll(async () => {
      const project = (await state()).project
      return [project?.layout, project?.zoom, project?.panes.map((pane) => pane.colorScheme)]
    })
    .toEqual(['horizontal', ZOOM, SCHEMES])

  // --- Quit and reopen: the project, its panes, layout and zoom come back --------------
  await closeApp(launched)
  launched = undefined
  const requestsBeforeRestart = fixture.requests().length
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  const restored = await openAndWait()
  const expectedPanes = stored.panes.map((pane, index) => ({
    ...pane,
    colorScheme: SCHEMES[index]
  }))
  expect(restored.project).toMatchObject({
    repoPath: repo,
    startUrl: `${fixture.a}/`,
    layout: 'horizontal',
    zoom: ZOOM,
    panes: expectedPanes
  })
  await expect(page.getByTestId('canvas')).toHaveAttribute('data-layout', 'horizontal')
  await expect(page.getByTestId('canvas')).toHaveAttribute('data-zoom', String(ZOOM))

  // --- Every pane, from outside the page ------------------------------------------------
  for (const pane of expectedPanes) {
    await reveal(page, pane.id)
    const expected = { width: (pane.width * ZOOM) / 100, height: (pane.height * ZOOM) / 100 }

    // Drawn at declared size times zoom, measured host-side on the element's own box.
    const box = await drawnBox(page, pane.id)
    expect({ width: box.width, height: box.height }, `${pane.name}'s drawn size`).toEqual(expected)
    expect(restored.panes[pane.id], `${pane.name}'s own geometry check`).toMatchObject({
      geometry: 'ok',
      degraded: []
    })

    // A real click near the bottom edge lands on the target that sits there.
    expect(await hitsBottomEdge(page, pane, 5_000), `${pane.name}'s bottom-edge target`).toBe(true)

    // The scheme it was left on, both as the page reads it and as the screen shows it.
    const id = await guestId(page, pane.id)
    expect(
      await inGuest<boolean>(id, `matchMedia('(prefers-color-scheme: dark)').matches`),
      `${pane.name}'s colour scheme`
    ).toBe(pane.colorScheme === 'dark')
    expect(await swatchColour(page, pane.id), `${pane.name}'s swatch on screen`).toEqual([
      ...SCHEME_SWATCH[pane.colorScheme as 'light' | 'dark']
    ])

    expect(await inGuest<number>(id, 'devicePixelRatio'), `${pane.name}'s DPR`).toBe(pane.dpr)
  }

  // DPR as the server saw it: each pane asked for the image variant its ratio implies —
  // Mobile @3x, Tablet @2x, Desktop @1x — and nothing else.
  expect(expectedPanes.map((pane) => pane.dpr)).toEqual([3, 2, 1])
  expect(assetsRequested(requestsBeforeRestart)).toEqual(['/asset?x=1', '/asset?x=2', '/asset?x=3'])

  // --- The negative control: Phase 0's collapse, and every check above catching it ------
  const [mobile] = expectedPanes
  await reveal(page, mobile.id)
  const declaredHeight = await webview(page, mobile.id).evaluate((element: HTMLElement) => {
    const height = element.style.height
    element.style.height = '150px'
    return height
  })
  const collapsedId = await guestId(page, mobile.id)

  // CDP still reports the declared viewport, which is why it proves nothing ([ADR-0004]).
  expect(
    await inGuest<{ width: number; height: number }>(
      collapsedId,
      '({ width: innerWidth, height: innerHeight })'
    )
  ).toEqual({ width: mobile.width, height: mobile.height })
  // The host-side measurement does not agree with it, nor does the app's own check…
  expect((await drawnBox(page, mobile.id)).height).toBe(75)
  await expect.poll(async () => (await state()).panes[mobile.id]?.geometry).toBe('mismatch')
  // …and the bottom edge can no longer be clicked.
  expect(await hitsBottomEdge(page, mobile, 2_000)).toBe(false)

  // Put back, it is whole again: the misses above were the collapse, not the probe.
  await webview(page, mobile.id).evaluate((element: HTMLElement, height) => {
    element.style.height = height
  }, declaredHeight)
  await expect.poll(async () => (await state()).panes[mobile.id]?.geometry).toBe('ok')
  await reveal(page, mobile.id)
  expect(await hitsBottomEdge(page, mobile, 5_000)).toBe(true)
})
