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
 * and the pixels of a swatch.
 *
 * The test then puts Phase 0's actual bug back — `display: block` on a `<webview>` — and
 * shows the click catching it. That bug leaves the element at its declared size and
 * collapses only the guest inside it, so CDP still reports the declared viewport, the
 * drawn size still measures right and the app's own geometry check still passes. The
 * bottom-edge click is the one check here that cannot be skipped.
 */

const ZOOM = 50

/** Explicit, and not all one value, so that a restart that dropped them would show. */
const SCHEMES: readonly Exclude<ColorScheme, 'system'>[] = ['dark', 'light', 'dark']

/** CSS pixels as the canvas draws them, in screen pixels. */
function atZoom(cssPixels: number): number {
  return (cssPixels * ZOOM) / 100
}

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
 * The pane's whole drawn area brought on screen, scrolled by the pane's own element
 * rather than its `<webview>`, so that the declared bottom edge — exactly the place a
 * click has to reach — is on screen whatever the `<webview>` is doing.
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
    const inset = atZoom(HIT_TARGET) / 4
    const bottom = box.y + atZoom(pane.height)
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
  const size = atZoom(SWATCH)
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

/**
 * The device pixel ratio the pane renders at, as a server sees it: the pane is handed an
 * image offered at 1x, 2x and 3x, tagged with its own id, and the variant it asks for is
 * the ratio it chose by. Tagged, so the answer is this pane's and not any pane's.
 */
async function dprAsServed(page: Page, pane: string): Promise<number> {
  const tag = `pane=${encodeURIComponent(pane)}`
  const variants = [1, 2, 3].map((x) => `/asset?x=${x}&${tag} ${x}x`).join(', ')
  await inGuest(
    await guestId(page, pane),
    `(() => {
      const image = new Image(16, 16)
      image.srcset = ${JSON.stringify(variants)}
      document.body.append(image)
    })()`
  )
  const asked = (): string[] =>
    fixture
      .requests()
      .map((request) => new URL(request.url, 'http://fixture'))
      .filter((url) => url.pathname === '/asset' && url.searchParams.get('pane') === pane)
      .map((url) => url.searchParams.get('x')!)
  await expect.poll(asked).toHaveLength(1)
  return Number(asked()[0])
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

  // `breakpoint . --wait --json` prints the pane set.
  launched = await launchApp(sandbox)
  const first = await openAndWait()
  expect(first.project?.repoPath).toBe(repo)
  expect(first.project?.panes).toEqual(stored.panes)
  expect(Object.keys(first.panes).sort()).toEqual(stored.panes.map((pane) => pane.id).sort())

  // The developer's changes, made through the same routes every surface uses.
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

  // Quit and reopen: the project, its panes, layout and zoom come back.
  await closeApp(launched)
  launched = undefined
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

  for (const pane of expectedPanes) {
    await reveal(page, pane.id)
    const expected = { width: atZoom(pane.width), height: atZoom(pane.height) }

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
      ...SCHEME_SWATCH[pane.colorScheme]
    ])

    // Its DPR as the server saw it, not as the page reports it.
    expect(await dprAsServed(page, pane.id), `${pane.name}'s DPR`).toBe(pane.dpr)
  }
  // Mobile @3x, Tablet @2x, Desktop @1x: three different answers, so none is a default.
  expect(expectedPanes.map((pane) => pane.dpr)).toEqual([3, 2, 1])

  // Phase 0's bug, put back on purpose: the element keeps its size, the guest collapses.
  const [mobile] = expectedPanes
  await reveal(page, mobile.id)
  const display = await webview(page, mobile.id).evaluate((element: HTMLElement) => {
    const display = element.style.display
    element.style.display = 'block'
    return display
  })
  const collapsedId = await guestId(page, mobile.id)

  // Everything that asks, or measures the element, still says the pane is whole…
  expect(
    await inGuest<{ width: number; height: number }>(
      collapsedId,
      '({ width: innerWidth, height: innerHeight })'
    )
  ).toEqual({ width: mobile.width, height: mobile.height })
  expect(await drawnBox(page, mobile.id)).toMatchObject({
    width: atZoom(mobile.width),
    height: atZoom(mobile.height)
  })
  expect((await state()).panes[mobile.id]?.geometry).toBe('ok')
  // …and the bottom edge cannot be clicked, which is the only one of them that is true.
  expect(await hitsBottomEdge(page, mobile, 2_000)).toBe(false)

  // Put back, it is whole again: the misses were the collapse, not the probe.
  await webview(page, mobile.id).evaluate((element: HTMLElement, display) => {
    element.style.display = display
  }, display)
  await reveal(page, mobile.id)
  expect(await hitsBottomEdge(page, mobile, 5_000)).toBe(true)
})
