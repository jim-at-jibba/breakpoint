import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_PANEL, type PanelSetting, type PanelState } from '../src/shared/panel'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type StoredProject
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { startFixture, type Fixture } from './fixture'
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
 * The panel, probed from outside (#73): the region it takes from the canvas, the file it
 * leaves behind, and what the panes make of being given the window back.
 *
 * The arrangement is an app setting, so every case reads it from the snapshot and the
 * settings file as well as from the window: a panel that looked right and was not kept,
 * or was kept and drawn somewhere else, would pass a test that read only one of them.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function makeRepo(name: string, changes: Partial<StoredProject> = {}): StoredProject {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: StoredProject = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}/`,
    ...changes
  }
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    JSON.stringify(writeProjectFile(project))
  )
  return project
}

async function open(project: StoredProject): Promise<void> {
  const run = await runCli(sandbox, ['.', '--json'], project.repoPath)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
}

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

async function setPanel(setting: PanelSetting): Promise<PanelState> {
  const response = await sendRaw(sandbox.socketPath, requestLine('app.setPanel', setting))
  expect(response).toMatchObject({ ok: true })
  return (response as { data: PanelState }).data
}

function storedPanel(): unknown {
  const file = join(sandbox.userDataDir, 'settings.json')
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { panel?: unknown }).panel
    : undefined
}

function box(page: Page, testId: string): Promise<Box> {
  return page.getByTestId(testId).evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
}

/** The panel's drawn size along the axis it docks on. */
async function drawnPanelSize(page: Page, panel: PanelState): Promise<number> {
  const drawn = await box(page, 'panel')
  // Whole pixels: the setting is kept whole, and layout lands within a subpixel of it.
  return Math.round(panel.side === 'bottom' ? drawn.height : drawn.width)
}

/**
 * The canvas, the handle and the panel tile the region exactly: the canvas gives up the
 * space the panel takes and not a pixel more, and nothing overlaps.
 */
async function expectTiled(page: Page, side: PanelState['side']): Promise<void> {
  const [group, canvas, handle, panel] = await Promise.all([
    box(page, 'panel-group'),
    box(page, 'canvas-region'),
    box(page, 'panel-handle'),
    box(page, 'panel')
  ])
  if (side === 'bottom') {
    expect(canvas.y).toBeCloseTo(group.y, 0)
    expect(handle.y).toBeCloseTo(canvas.y + canvas.height, 0)
    expect(panel.y).toBeCloseTo(handle.y + handle.height, 0)
    expect(canvas.height + handle.height + panel.height).toBeCloseTo(group.height, 0)
    for (const part of [canvas, panel]) expect(part.width).toBeCloseTo(group.width, 0)
  } else {
    expect(canvas.x).toBeCloseTo(group.x, 0)
    expect(handle.x).toBeCloseTo(canvas.x + canvas.width, 0)
    expect(panel.x).toBeCloseTo(handle.x + handle.width, 0)
    expect(canvas.width + handle.width + panel.width).toBeCloseTo(group.width, 0)
    for (const part of [canvas, panel]) expect(part.height).toBeCloseTo(group.height, 0)
  }
}

async function canvasZoom(page: Page): Promise<number> {
  return Number(await page.getByTestId('canvas').getAttribute('data-zoom'))
}

function guestId(page: Page, pane: string): Promise<number> {
  return page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
}

/** The frame the guest is drawn into, which is what the host-side check measures. */
function frameBox(page: Page, pane: string): Promise<{ width: number; height: number }> {
  return page.locator(`webview[data-pane="${pane}"]`).evaluate((element) => {
    const frame = element.shadowRoot?.querySelector('iframe')
    const { width, height } = frame?.getBoundingClientRect() ?? { width: 0, height: 0 }
    return { width, height }
  })
}

async function geometryChecked(project: StoredProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const panes = (await state()).panes
        return project.panes.map((pane) => panes[pane.id]?.geometry)
      },
      { timeout: 20_000 }
    )
    .toEqual(project.panes.map(() => 'ok'))
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
  repos = mkdtempSync(join(tmpdir(), 'bp-repos-'))
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repos, { recursive: true, force: true })
})

test('the panel docks below or beside the canvas, and the canvas gives up exactly its space', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await open(makeRepo('shop'))

  expect((await state()).panel).toEqual(DEFAULT_PANEL)
  await expect(page.getByTestId('panel-tab')).toHaveText(['Console'])
  await expect(page.getByTestId('panel-tab')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => drawnPanelSize(page, DEFAULT_PANEL)).toBe(DEFAULT_PANEL.sizes.bottom)
  await expectTiled(page, 'bottom')
  // Nothing was chosen, so there is nothing to keep.
  expect(storedPanel()).toBeUndefined()

  await page.getByTestId('panel-side-toggle').click()

  await expect(page.getByTestId('panel-group')).toHaveAttribute('data-side', 'right')
  const beside = (await state()).panel
  expect(beside).toEqual({ ...DEFAULT_PANEL, side: 'right' })
  await expect.poll(() => drawnPanelSize(page, beside)).toBe(DEFAULT_PANEL.sizes.right)
  await expectTiled(page, 'right')
  expect(storedPanel()).toEqual(beside)

  // From a terminal too: the route is the only way the arrangement changes.
  const sized = await setPanel({ side: 'bottom', size: 200 })
  await expect(page.getByTestId('panel-group')).toHaveAttribute('data-side', 'bottom')
  await expect.poll(() => drawnPanelSize(page, sized)).toBe(200)
  await expectTiled(page, 'bottom')
})

test('a resize made in the window is kept, and survives a restart', async () => {
  launched = await launchApp(sandbox)
  let page = await launched.app.firstWindow()
  await open(makeRepo('shop'))
  await expect.poll(() => drawnPanelSize(page, DEFAULT_PANEL)).toBe(DEFAULT_PANEL.sizes.bottom)

  const handle = await box(page, 'panel-handle')
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 40, { steps: 8 })
  await page.mouse.move(x, y - 80, { steps: 8 })
  await page.mouse.up()

  await expect
    .poll(async () => (await state()).panel.sizes.bottom)
    .toBeGreaterThan(DEFAULT_PANEL.sizes.bottom + 60)
  const kept = (await state()).panel
  expect(await drawnPanelSize(page, kept)).toBe(kept.sizes.bottom)
  expect(storedPanel()).toEqual(kept)
  await closeApp(launched)

  launched = await launchApp(sandbox)
  page = await launched.app.firstWindow()

  expect((await state()).panel).toEqual(kept)
  await expect.poll(() => drawnPanelSize(page, kept)).toBe(kept.sizes.bottom)
})

test('switching projects leaves the panel arranged as it was', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  const blog = makeRepo('blog', { layout: 'focus' })
  await open(shop)
  const arranged = await setPanel({ side: 'right', size: 380 })
  await expect.poll(() => drawnPanelSize(page, arranged)).toBe(380)
  const shopPane = await guestId(page, shop.panes[0].id)

  await open(blog)
  await expect(page.locator(`webview[data-pane="${blog.panes[0].id}"]`)).toBeVisible()

  expect((await state()).panel).toEqual(arranged)
  expect(storedPanel()).toEqual(arranged)
  await expect(page.getByTestId('panel-group')).toHaveAttribute('data-side', 'right')
  expect(await drawnPanelSize(page, arranged)).toBe(380)
  await expectTiled(page, 'right')
  // And a project the panel stayed put for is not a pane of the last one.
  expect(await guestId(page, blog.panes[0].id)).not.toBe(shopPane)
})

test('hiding the panel gives the canvas the whole window, and the panes are measured again', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  // Fit, so the canvas growing is a change every pane is drawn at, and the host-side
  // check has to measure them all again rather than passing on sizes it already knew.
  const shop = makeRepo('shop', { zoom: 'fit' })
  await setPanel({ side: 'right' })
  await open(shop)
  await geometryChecked(shop)
  const guests = await Promise.all(shop.panes.map((pane) => guestId(page, pane.id)))
  const docked = await canvasZoom(page)
  const group = await box(page, 'panel-group')

  await page.getByTestId('panel-hide').click()

  await expect(page.getByTestId('panel')).toHaveCount(0)
  await expect(page.getByTestId('panel-toggle')).toHaveAttribute('aria-pressed', 'false')
  expect((await state()).panel).toEqual({ ...DEFAULT_PANEL, side: 'right', visible: false })
  // The whole of the region is the canvas's again.
  const canvas = await box(page, 'canvas-region')
  expect(canvas.width).toBeCloseTo(group.width, 0)
  expect(canvas.height).toBeCloseTo(group.height, 0)

  // Given the room, Fit draws the panes larger, and the check passes at what they are
  // drawn at now — measured on the guest's frame, not taken on trust ([ADR-0004]).
  await expect.poll(() => canvasZoom(page)).toBeGreaterThan(docked)
  const zoom = await canvasZoom(page)
  await geometryChecked(shop)
  for (const pane of shop.panes) {
    const frame = await frameBox(page, pane.id)
    expect(frame.width).toBeCloseTo((pane.width * zoom) / 100, 0)
    expect(frame.height).toBeCloseTo((pane.height * zoom) / 100, 0)
  }
  // Hiding moved no pane's guest: the canvas stays where it is in the tree.
  expect(await Promise.all(shop.panes.map((pane) => guestId(page, pane.id)))).toEqual(guests)

  await page.getByTestId('panel-toggle').click()

  await expect(page.getByTestId('panel')).toBeVisible()
  await expect.poll(() => canvasZoom(page)).toBe(docked)
  await expectTiled(page, 'right')
  await geometryChecked(shop)
})

test('the route refuses an arrangement it cannot draw, and changes nothing', async () => {
  launched = await launchApp(sandbox)
  await launched.app.firstWindow()

  for (const params of [{}, { side: 'left' }, { size: 0 }, { visible: 'no' }]) {
    const response = await sendRaw(sandbox.socketPath, requestLine('app.setPanel', params))
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
  }
  expect((await state()).panel).toEqual(DEFAULT_PANEL)
  expect(storedPanel()).toBeUndefined()
})
