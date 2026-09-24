import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { MAX_ZOOM, MIN_ZOOM } from '../src/shared/canvas'
import type { Entry, LogRead } from '../src/shared/event-log'
import { ROUTE_CHANNEL } from '../src/shared/ipc'
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
 * Canvas zoom and the two layouts, probed from outside. The claim under test is that
 * zoom scales rendering only: whatever a pane is drawn at, the page inside it is laid
 * out at the size the pane declares, and the host-side geometry check is made against
 * declared size times that zoom ([ADR-0004]).
 *
 * Fit is a value of the zoom control rather than a third layout ([ADR-0009]), so there
 * is nothing here that reads one state for the zoom and another for the mode.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

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

async function logs(since = 0): Promise<Entry[]> {
  const run = await runCli(sandbox, ['logs', '--since', String(since), '--json'])
  expect(run.code).toBe(0)
  return [...(JSON.parse(run.stdout) as LogRead).entries]
}

function ofType(entries: Entry[], type: Entry['type'], pane?: string): Entry[] {
  return entries.filter(
    (entry) => entry.type === type && (pane === undefined || entry.pane === pane)
  )
}

async function settled(project: StoredProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const [entries, snapshot] = await Promise.all([logs(), state()])
        return project.panes.every(
          (pane) =>
            ofType(entries, 'pane.loaded', pane.id).length > 0 &&
            snapshot.panes[pane.id]?.geometry !== 'unchecked'
        )
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

function webviewBox(page: Page, pane: string): Promise<{ width: number; height: number }> {
  return page.locator(`webview[data-pane="${pane}"]`).evaluate((element) => {
    const { width, height } = element.getBoundingClientRect()
    return { width, height }
  })
}

function guestId(page: Page, pane: string): Promise<number> {
  return page.locator(`webview[data-pane="${pane}"]`).evaluate((element) =>
    (
      element as unknown as {
        getWebContentsId(): number
      }
    ).getWebContentsId()
  )
}

async function guestIds(page: Page, project: StoredProject): Promise<Record<string, number>> {
  return Object.fromEntries(
    await Promise.all(
      project.panes.map(async (pane) => [pane.id, await guestId(page, pane.id)] as const)
    )
  )
}

/** What the canvas says it is drawing at, which is what the geometry check is made against. */
async function canvasZoom(page: Page): Promise<number> {
  return Number(await page.getByTestId('canvas').getAttribute('data-zoom'))
}

/** The pane's own account of its viewport, which is the thing zoom must not change. */
function guestViewport(page: Page, pane: string): Promise<{ width: number; height: number }> {
  return page.locator(`webview[data-pane="${pane}"]`).evaluate((element) =>
    (
      element as unknown as {
        executeJavaScript(script: string): Promise<{ width: number; height: number }>
      }
    ).executeJavaScript('({ width: innerWidth, height: innerHeight })')
  )
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

test('Fit draws every pane without scrolling, and each pane still lays its page out at its declared size', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 'fit' })

  await open(shop)
  await settled(shop)

  // A concrete zoom inside the control's range, and smaller than 100 — three panes
  // 2,650 CSS px wide do not fit a 1,280px window at full size.
  const zoom = await canvasZoom(page)
  expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  expect(zoom).toBeLessThan(MAX_ZOOM)

  const scroll = await page.getByTestId('canvas').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  }))
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
  expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight)

  for (const pane of shop.panes) {
    const box = await webviewBox(page, pane.id)
    expect(box.width).toBeCloseTo((pane.width * zoom) / 100, 0)
    expect(box.height).toBeCloseTo((pane.height * zoom) / 100, 0)
    // Scaled on the canvas, and unaware of it: the page's viewport is what it declares.
    expect(await guestViewport(page, pane.id)).toEqual({
      width: pane.width,
      height: pane.height
    })
    // Which is also what the host-side check compared against, rather than against 100%.
    expect((await state()).panes[pane.id].geometry).toBe('ok')
  }

  // Fit is the stored value; what it came to is the window's and is not stored.
  expect((await state()).project?.zoom).toBe('fit')
  expect((await runCli(sandbox, ['state'])).stdout).toContain('Horizontal, zoom Fit')
})

test('touching the zoom control while on Fit leaves a concrete zoom with nothing to contradict it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 'fit' })
  await open(shop)
  await settled(shop)

  await expect(page.getByTestId('zoom-value')).toHaveText('Fit')
  await expect(page.getByTestId('zoom-fit')).toHaveAttribute('aria-pressed', 'true')
  const fitting = await canvasZoom(page)
  // The slider sits where Fit put it, so the two can never read differently.
  await expect(page.getByTestId('zoom')).toHaveValue(String(fitting))

  await page.getByTestId('zoom').fill('60')
  await page.getByTestId('zoom').press('Enter')

  await expect.poll(async () => (await state()).project?.zoom).toBe(60)
  await expect(page.getByTestId('zoom-value')).toHaveText('60%')
  await expect(page.getByTestId('zoom-fit')).toHaveAttribute('aria-pressed', 'false')
  expect(await canvasZoom(page)).toBe(60)
  const [mobile] = shop.panes
  await expect
    .poll(async () => (await webviewBox(page, mobile.id)).width)
    .toBeCloseTo(mobile.width * 0.6, 0)

  // And back: Fit is a value of the same control, so choosing it is not leaving a mode.
  await page.getByTestId('zoom-fit').click()
  await expect.poll(async () => (await state()).project?.zoom).toBe('fit')
  await expect(page.getByTestId('zoom-value')).toHaveText('Fit')
})

test('dragging the zoom previews every value but persists only the committed value', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 'fit' })
  await open(shop)
  await settled(shop)
  const { cursor } = await state()

  const slider = page.getByTestId('zoom')
  for (const value of ['40', '50', '60']) await slider.fill(value)

  await expect(page.getByTestId('canvas')).toHaveAttribute('data-zoom', '60')
  expect((await state()).project?.zoom).toBe('fit')

  await slider.dispatchEvent('pointerup')
  await expect.poll(async () => (await state()).project?.zoom).toBe(60)
  expect(ofType(await logs(cursor), 'project.zoomChanged')).toEqual([
    expect.objectContaining({ zoom: 60 })
  ])
})

test('a failed canvas action is visible in app-owned chrome', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 100 })
  await open(shop)
  await settled(shop)

  await launched.app.evaluate(({ ipcMain }, channel: string) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, request: { id: string }) => ({
      id: request.id,
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'disk full' }
    }))
  }, ROUTE_CHANNEL)

  await page.getByTestId('zoom-fit').click()

  await expect(page.getByRole('alert')).toHaveText(
    'Could not update canvas: INTERNAL_ERROR: disk full'
  )
})

test('a zoom past the ends of the control is clamped, and a zoom that is not one is refused', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', { zoom: 'fit' })
  await open(shop)
  await settled(shop)

  for (const [asked, kept] of [
    [400, MAX_ZOOM],
    [1, MIN_ZOOM],
    [43.4, 43]
  ] as const) {
    expect(
      await sendRaw(sandbox.socketPath, requestLine('project.setZoom', { zoom: asked }))
    ).toEqual({ id: 'test', ok: true, data: { zoom: kept } })
    expect((await state()).project?.zoom).toBe(kept)
  }

  const before = await state()
  for (const params of [undefined, { zoom: 'huge' }, { zoom: null }, {}]) {
    expect(await sendRaw(sandbox.socketPath, requestLine('project.setZoom', params))).toEqual({
      id: 'test',
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: 'this route takes { zoom }: a number of percent, or "fit"'
      }
    })
  }
  expect((await state()).project?.zoom).toBe(before.project?.zoom)
})

test('Focus draws one pane at 100% with the rest as a strip, and the focused pane can be changed', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 'fit' })
  await open(shop)
  await settled(shop)
  const [mobile, tablet, desktop] = shop.panes
  const guests = await guestIds(page, shop)

  expect(
    await sendRaw(
      sandbox.socketPath,
      requestLine('project.setLayout', { layout: 'focus', focusedPane: tablet.id })
    )
  ).toEqual({ id: 'test', ok: true, data: { layout: 'focus', focusedPane: tablet.id } })

  // The focused pane, on the canvas at 100%: drawn at exactly what it declares.
  await expect(page.locator('[data-testid="pane"][data-focused="true"]')).toHaveAttribute(
    'data-pane',
    tablet.id
  )
  expect(await guestIds(page, shop)).toEqual(guests)
  await expect
    .poll(async () => webviewBox(page, tablet.id))
    .toEqual({
      width: tablet.width,
      height: tablet.height
    })

  // The toolbar reads what the canvas draws rather than what Fit would have come to, so
  // there is no second opinion about the zoom while Focus is holding its pane at 100%.
  await expect(page.getByTestId('zoom-value')).toHaveText('100%')
  await expect(page.getByTestId('zoom')).toBeDisabled()

  // The others as a strip, every one of them drawn to the same height whatever it declares.
  const strip = page.locator('[data-testid="pane"][data-strip="true"]')
  await expect(strip).toHaveCount(2)
  expect(
    await strip.evaluateAll((elements) => elements.map((e) => e.getAttribute('data-pane')))
  ).toEqual([mobile.id, desktop.id])
  for (const pane of [mobile, desktop]) {
    const box = await webviewBox(page, pane.id)
    expect(box.height).toBeCloseTo((await webviewBox(page, mobile.id)).height, 0)
    expect(box.height).toBeLessThan(pane.height)
  }

  // Every pane is still measured against what it is drawn at, strip included.
  for (const pane of shop.panes) {
    await expect.poll(async () => (await state()).panes[pane.id].degraded).toEqual([])
  }

  // Clicking a strip pane focuses it, and the click never reaches the page it is showing.
  await page.locator(`[data-testid="focus-pane"][data-pane="${desktop.id}"]`).click()
  await expect.poll(async () => (await state()).project?.focusedPane).toBe(desktop.id)
  await expect(page.locator('[data-testid="pane"][data-focused="true"]')).toHaveAttribute(
    'data-pane',
    desktop.id
  )
  expect(await guestIds(page, shop)).toEqual(guests)
  await expect
    .poll(async () => webviewBox(page, desktop.id))
    .toEqual({
      width: desktop.width,
      height: desktop.height
    })

  for (const pane of shop.panes) {
    expect(await guestViewport(page, pane.id)).toEqual({ width: pane.width, height: pane.height })
  }

  expect((await runCli(sandbox, ['state'])).stdout).toContain('Focus on Desktop')
})

test('the layout and the zoom survive a restart', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', { zoom: 'fit' })
  await open(shop)
  await settled(shop)
  const [, tablet] = shop.panes

  await sendRaw(sandbox.socketPath, requestLine('project.setZoom', { zoom: 60 }))
  await sendRaw(
    sandbox.socketPath,
    requestLine('project.setLayout', { layout: 'focus', focusedPane: tablet.id })
  )

  await closeApp(launched)
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await open(shop)
  await settled(shop)

  expect((await state()).project).toMatchObject({
    zoom: 60,
    layout: 'focus',
    focusedPane: tablet.id
  })
  await expect(page.getByTestId('canvas')).toHaveAttribute('data-layout', 'focus')
  await expect(page.locator('[data-testid="pane"][data-focused="true"]')).toHaveAttribute(
    'data-pane',
    tablet.id
  )
})

test('the geometry check catches a pane drawn wrong at a zoom other than 100%', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 50 })
  await open(shop)
  await settled(shop)
  const [mobile, tablet] = shop.panes
  const { cursor } = await state()
  expect(await canvasZoom(page)).toBe(50)

  // The Phase 0 bug at half size. What is compared is screen pixels, so the expected
  // size is the declared one halved — not the declared one, which would hide this.
  await page
    .locator(`webview[data-pane="${mobile.id}"]`)
    .evaluate((element: HTMLElement) => (element.style.height = '150px'))

  const message = 'drawn 195×75, declared 195×422 at this zoom'
  await expect
    .poll(async () => (await state()).panes[mobile.id])
    .toMatchObject({ geometry: 'mismatch', degraded: [{ cause: 'geometry', message }] })
  expect((await state()).panes[tablet.id].degraded).toEqual([])
  expect(ofType(await logs(cursor), 'pane.geometryMismatch')).toEqual([
    expect.objectContaining({
      pane: mobile.id,
      expected: { width: 195, height: 422 },
      measured: { width: 195, height: 75 }
    })
  ])
})
