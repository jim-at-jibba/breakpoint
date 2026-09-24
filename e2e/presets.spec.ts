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
import { ROUTE_CHANNEL } from '../src/shared/ipc'
import {
  DEFAULT_PRESETS,
  readPresetFile,
  writePresetFile,
  type Preset
} from '../src/shared/presets'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Pane,
  type StoredProject
} from '../src/shared/project'
import type { PaneListing } from '../src/shared/routes'
import type { StateSnapshot } from '../src/shared/state'
import { HIT_TARGET, startFixture, type Fixture, type RecordedRequest } from './fixture'
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
 * The pane set as the developer shapes it: added from a preset or at a size of their own,
 * removed, resized by typing, rotated. Driven through both surfaces — the socket for the
 * routes, the window's own controls for what a developer actually clicks — and confirmed
 * against what the guest renders and what the server is told, never against the app's own
 * account of itself.
 *
 * The standing property under all of it is [ADR-0011]: a preset is resolved once, at
 * creation, so a preset edited afterwards is felt by the next pane and by no pane already
 * saved.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

function presetFile(): string {
  return join(sandbox.userDataDir, 'presets.json')
}

function writePresets(presets: readonly Preset[]): void {
  mkdirSync(sandbox.userDataDir, { recursive: true })
  writeFileSync(presetFile(), `${JSON.stringify(writePresetFile(presets), null, 2)}\n`)
}

function storedPresets(): Preset[] {
  const read = readPresetFile(JSON.parse(readFileSync(presetFile(), 'utf8')))
  expect(read.ok).toBe(true)
  return read.ok ? read.presets : []
}

/** The seven defaults with one of them edited, which is what a user-editable file is for. */
function presetsWith(id: string, changes: Partial<Preset>): Preset[] {
  return DEFAULT_PRESETS.map((preset) => (preset.id === id ? { ...preset, ...changes } : preset))
}

function makeRepo(name: string, changes: Partial<StoredProject> = {}): StoredProject {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: StoredProject = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}/`,
    // Pane-management assertions use exact screen pixels; zoom behavior belongs to #13.
    zoom: 100,
    ...changes
  }
  saveProject(project)
  return project
}

function saveProject(project: StoredProject): void {
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    JSON.stringify(writeProjectFile(project))
  )
}

/** A repo with no stored project, so opening it creates one from the presets as they are. */
function emptyRepo(name: string): string {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  return realpathSync.native(path)
}

async function open(repoPath: string): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['.', '--json'], repoPath)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

function panesOf(snapshot: StateSnapshot): Pane[] {
  return snapshot.project?.panes ?? []
}

async function route<T>(name: string, params?: unknown): Promise<T> {
  const response = await sendRaw(sandbox.socketPath, requestLine(name, params))
  expect(response.ok, response.ok ? '' : `${name}: ${response.error.message}`).toBe(true)
  return (response as { data: T }).data
}

async function addPane(params: unknown): Promise<PaneListing> {
  const { pane } = await route<{ pane: PaneListing }>('panes.add', params)
  return pane
}

/** Waits until the window has drawn exactly this pane set, in this order. */
async function drawn(page: Page, ids: readonly string[]): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId('pane')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-pane'))),
      { timeout: 10_000 }
    )
    .toEqual([...ids])
}

function webviewBox(page: Page, pane: string): Promise<{ width: number; height: number }> {
  return page.locator(`webview[data-pane="${pane}"]`).evaluate((element) => {
    const { width, height } = element.getBoundingClientRect()
    return { width, height }
  })
}

/** Waits for a pane's guest to have loaded, which is the first document it asks for. */
async function loaded(pane: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await state()
        return snapshot.panes[pane]?.attachment
      },
      { timeout: 20_000 }
    )
    .toBe('attached')
}

function documents(): RecordedRequest[] {
  return fixture.requests().filter((request) => request.url.split('?')[0] === '/')
}

/**
 * A real click just inside the drawn bottom-right corner, landing on the page's own
 * bottom-right target. It can only land if the page laid out at the pane's declared size,
 * which is the thing CDP's own account of the viewport cannot tell us ([ADR-0004]).
 */
async function cornerIsHit(page: Page, pane: string): Promise<void> {
  const webview = page.locator(`webview[data-pane="${pane}"]`)
  await webview.evaluate((element) => element.scrollIntoView({ inline: 'end', block: 'end' }))
  const box = await webview.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
  const id = await webview.evaluate((element) =>
    (element as unknown as { getWebContentsId(): number }).getWebContentsId()
  )
  const inset = HIT_TARGET / 4
  await expect(async () => {
    await page.mouse.click(box.x + box.width - inset, box.y + box.height - inset)
    const hits = await launched!.app.evaluate(
      ({ webContents }, guest) =>
        webContents
          .fromId(guest)!
          .executeJavaScript(`document.getElementById('corner').dataset.hits`),
      id
    )
    expect(Number(hits), `${pane}'s bottom-right target`).toBeGreaterThan(0)
  }).toPass({ timeout: 10_000 })
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

test('the presets file is seeded with the seven defaults and listed to every surface', async () => {
  launched = await launchApp(sandbox)

  const { presets } = await route<{ presets: Preset[] }>('presets.list')

  expect(presets).toEqual([...DEFAULT_PRESETS])
  expect(storedPresets()).toEqual([...DEFAULT_PRESETS])
})

test('a new project is created with the default three panes, resolved from the presets file', async () => {
  // Edited before the app ever runs, so nothing but the file can be the source of these.
  writePresets(presetsWith('mobile', { name: 'Mobile (small)', width: 320, height: 568 }))
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  const opened = await open(emptyRepo('shop'))

  const panes = panesOf(opened)
  expect(opened.project?.zoom).toBe('fit')
  expect(panes.map((pane) => [pane.name, pane.width, pane.height, pane.preset])).toEqual([
    ['Mobile (small)', 320, 568, 'mobile'],
    ['Tablet', 820, 1180, 'tablet'],
    ['Desktop', 1440, 900, 'desktop']
  ])
  await route('project.setZoom', { zoom: 100 })
  await drawn(
    page,
    panes.map((pane) => pane.id)
  )
  expect(await webviewBox(page, panes[0].id)).toEqual({ width: 320, height: 568 })
})

test('a pane added from a preset takes its size, DPR, user agent, mobile flag and touch', async () => {
  const KIOSK = 'Kiosk/1.0 (Shelf; Breakpoint test)'
  writePresets([
    ...DEFAULT_PRESETS,
    {
      id: 'kiosk',
      name: 'Kiosk',
      width: 700,
      height: 500,
      dpr: 2,
      mobile: true,
      touch: true,
      userAgent: KIOSK
    }
  ])
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const before = documents().length

  const pane = await addPane({ preset: 'kiosk' })

  // Declared exactly as the preset says, with the preset remembered for display only.
  expect(pane).toMatchObject({
    name: 'Kiosk',
    width: 700,
    height: 500,
    dpr: 2,
    mobile: true,
    touch: true,
    userAgent: KIOSK,
    preset: 'kiosk',
    session: 'default'
  })
  await drawn(page, [...shop.panes.map((candidate) => candidate.id), pane.id])
  expect(await webviewBox(page, pane.id)).toEqual({ width: 700, height: 500 })
  await loaded(pane.id)

  // And emulated as the preset says: the server is told the preset's user agent, the
  // guest has touch, and the image it asks for is the one its DPR implies.
  await expect
    .poll(() =>
      documents()
        .slice(before)
        .map((request) => request.headers['user-agent'])
    )
    .toContain(KIOSK)
  const guest = await page
    .locator(`webview[data-pane="${pane.id}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
  expect(
    await launched.app.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript(`'ontouchstart' in window`),
      guest
    )
  ).toBe(true)
  await expect.poll(() => fixture.requests().map((request) => request.url)).toContain('/asset?x=2')
})

test('a pane can be added at a width and height of the developer’s own, belonging to no preset', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)

  const pane = await addPane({ width: 1024, height: 768 })

  expect(pane).toMatchObject({
    name: '1024×768',
    width: 1024,
    height: 768,
    dpr: 1,
    mobile: false,
    touch: false,
    userAgent: null,
    preset: null
  })
  await drawn(page, [...shop.panes.map((candidate) => candidate.id), pane.id])
  expect(await webviewBox(page, pane.id)).toEqual({ width: 1024, height: 768 })
  await loaded(pane.id)
  await cornerIsHit(page, pane.id)
})

test('the window’s own add-pane control adds the preset a developer picks', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )

  await page.getByTestId('add-pane').click()
  await page.locator('[data-testid="add-pane-preset"][data-preset="mobileL"]').click()

  await expect.poll(async () => panesOf(await state()).length).toBe(4)
  const added = panesOf(await state()).at(-1)!
  expect(added).toMatchObject({ name: 'Mobile L', width: 430, height: 932, preset: 'mobileL' })
  await drawn(page, [...shop.panes.map((pane) => pane.id), added.id])
})

test('removing a pane leaves the rest untouched and survives a restart', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile, tablet, desktop] = shop.panes
  await drawn(page, [mobile.id, tablet.id, desktop.id])

  await route('panes.remove', { pane: tablet.id })

  expect(panesOf(await state())).toEqual([mobile, desktop])
  await drawn(page, [mobile.id, desktop.id])

  await closeApp(launched)
  launched = await launchApp(sandbox)
  const restarted = await launched.app.firstWindow()

  expect(panesOf(await open(shop.repoPath))).toEqual([mobile, desktop])
  await drawn(restarted, [mobile.id, desktop.id])
})

test('a pane resized by typing exact dimensions lays its page out at the new size', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )
  await loaded(mobile.id)

  // Typed into the pane's own header, as a developer does it, and committed with Enter.
  const header = page.locator(`[data-testid="pane"][data-pane="${mobile.id}"]`)
  await header.getByTestId('pane-width').fill('500')
  await header.getByTestId('pane-width').press('Enter')
  await header.getByTestId('pane-height').fill('700')
  await header.getByTestId('pane-height').press('Enter')

  await expect
    .poll(async () => {
      const pane = panesOf(await state()).find((candidate) => candidate.id === mobile.id)
      return pane && { width: pane.width, height: pane.height }
    })
    .toEqual({ width: 500, height: 700 })
  expect(await webviewBox(page, mobile.id)).toEqual({ width: 500, height: 700 })
  // The emulated viewport followed: the page's bottom-right corner is the pane's.
  await cornerIsHit(page, mobile.id)
})

test('Escape cancels a typed pane size without saving it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )

  const width = page
    .locator(`[data-testid="pane"][data-pane="${mobile.id}"]`)
    .getByTestId('pane-width')
  await width.fill('500')
  await width.press('Escape')
  await expect(width).toHaveValue(String(mobile.width))

  await expect.poll(async () => panesOf(await state())[0].width).toBe(mobile.width)
})

test('pane controls show structured route failures in the pane header', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )
  await launched.app.evaluate(({ ipcMain }, route) => {
    ipcMain.removeHandler(route)
    ipcMain.handle(route, (_event, request: { id: string; route: string }) => ({
      id: request.id,
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: `${request.route} failed` }
    }))
  }, ROUTE_CHANNEL)

  const header = page.locator(`[data-testid="pane"][data-pane="${mobile.id}"]`)
  await header.getByTestId('pane-rotate').click()
  await expect(header.getByTestId('pane-action-error')).toHaveAttribute(
    'title',
    'panes.rotate failed'
  )
  await header.getByTestId('pane-remove').click()
  await expect(header.getByTestId('pane-action-error')).toHaveAttribute(
    'title',
    'panes.remove failed'
  )
  await header.getByTestId('pane-width').fill('500')
  await header.getByTestId('pane-width').press('Enter')
  await expect(header.getByTestId('pane-action-error')).toHaveAttribute(
    'title',
    'panes.resize failed'
  )
})

test('pane controls show rejected IPC calls in the pane header', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )
  await launched.app.evaluate(({ ipcMain }, route) => {
    ipcMain.removeHandler(route)
    ipcMain.handle(route, (_event, request: { route: string }) => {
      throw new Error(`${request.route} unavailable`)
    })
  }, ROUTE_CHANNEL)

  const header = page.locator(`[data-testid="pane"][data-pane="${mobile.id}"]`)
  await header.getByTestId('pane-rotate').click()
  await expect(header.getByTestId('pane-action-error')).toContainText('panes.rotate unavailable')
  await header.getByTestId('pane-remove').click()
  await expect(header.getByTestId('pane-action-error')).toContainText('panes.remove unavailable')
  await header.getByTestId('pane-width').fill('500')
  await header.getByTestId('pane-width').press('Enter')
  await expect(header.getByTestId('pane-action-error')).toContainText('panes.resize unavailable')
})

test('an obsolete pane action failure cannot replace a newer successful result', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )
  await launched.app.evaluate(({ ipcMain }, route) => {
    ipcMain.removeHandler(route)
    ipcMain.handle(route, async (_event, request: { id: string; route: string }) => {
      if (request.route === 'panes.rotate') {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return {
          id: request.id,
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'obsolete rotate failure' }
        }
      }
      return { id: request.id, ok: true, data: {} }
    })
  }, ROUTE_CHANNEL)

  const header = page.locator(`[data-testid="pane"][data-pane="${mobile.id}"]`)
  await header.getByTestId('pane-rotate').click()
  await header.getByTestId('pane-remove').click()
  await page.waitForTimeout(300)
  await expect(header.getByTestId('pane-action-error')).toHaveCount(0)
})

test('reopening the add menu hides stale presets and ignores an older read finishing last', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  await page.getByTestId('add-pane').click()
  await expect(page.getByTestId('add-pane-preset')).toHaveCount(DEFAULT_PRESETS.length)
  await page.getByTestId('add-pane').click()

  const edited = presetsWith('laptop', { name: 'Laptop HD', width: 1366 })
  await launched.app.evaluate(
    ({ ipcMain }, { route, stale, current }) => {
      ipcMain.removeHandler(route)
      let reads = 0
      ipcMain.handle(route, async (_event, request: { id: string; route: string }) => {
        if (request.route !== 'presets.list') {
          return {
            id: request.id,
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'not part of this test' }
          }
        }
        reads += 1
        const first = reads === 1
        await new Promise((resolve) => setTimeout(resolve, first ? 250 : 25))
        return { id: request.id, ok: true, data: { presets: first ? stale : current } }
      })
    },
    { route: ROUTE_CHANNEL, stale: DEFAULT_PRESETS, current: edited }
  )

  await page.getByTestId('add-pane').click()
  await expect(page.getByText('Reading presets…')).toBeVisible()
  await expect(page.getByTestId('add-pane-preset')).toHaveCount(0)
  await page.getByTestId('add-pane').click()
  await page.getByTestId('add-pane').click()
  await expect(page.locator('[data-testid="add-pane-preset"][data-preset="laptop"]')).toContainText(
    'Laptop HD'
  )
  await page.waitForTimeout(300)
  await expect(page.locator('[data-testid="add-pane-preset"][data-preset="laptop"]')).toContainText(
    'Laptop HD'
  )
})

test('rotating a pane swaps its dimensions, and twice is where it started', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes
  await drawn(
    page,
    shop.panes.map((pane) => pane.id)
  )

  await page.locator(`[data-testid="pane-rotate"][data-pane="${mobile.id}"]`).click()

  await expect.poll(() => webviewBox(page, mobile.id)).toEqual({ width: 844, height: 390 })
  await loaded(mobile.id)
  await cornerIsHit(page, mobile.id)

  await route('panes.rotate', { pane: mobile.id })
  await expect
    .poll(() => webviewBox(page, mobile.id))
    .toEqual({ width: mobile.width, height: mobile.height })
})

test('editing a preset shapes the panes added afterwards and leaves every saved pane alone', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop.repoPath)

  const first = await addPane({ preset: 'laptop' })
  expect(first).toMatchObject({ width: 1280, height: 800 })

  // The file is the developer's, edited while the app runs and read again on the next add.
  writePresets(presetsWith('laptop', { name: 'Laptop HD', width: 1366, height: 768 }))
  const second = await addPane({ preset: 'laptop' })

  expect(second).toMatchObject({ name: 'Laptop HD', width: 1366, height: 768, preset: 'laptop' })
  // The pane created before the edit is untouched, in state and on disk.
  const panes = panesOf(await state())
  expect(panes.find((pane) => pane.id === first.id)).toMatchObject({
    name: 'Laptop',
    width: 1280,
    height: 800
  })
  await drawn(page, [...shop.panes.map((pane) => pane.id), first.id, second.id])
  expect(await webviewBox(page, first.id)).toEqual({ width: 1280, height: 800 })

  await closeApp(launched)
  launched = await launchApp(sandbox)
  expect(panesOf(await open(shop.repoPath)).map((pane) => [pane.name, pane.width])).toEqual([
    ['Mobile', 390],
    ['Tablet', 820],
    ['Desktop', 1440],
    ['Laptop', 1280],
    ['Laptop HD', 1366]
  ])
})

test('a presets file that cannot be read refuses rather than being overwritten', async () => {
  const broken = '{ "version": 1, "presets": [ oops ] }'
  mkdirSync(sandbox.userDataDir, { recursive: true })
  writeFileSync(presetFile(), broken)
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  await open(shop.repoPath)

  const listed = await sendRaw(sandbox.socketPath, requestLine('presets.list'))
  const added = await sendRaw(sandbox.socketPath, requestLine('panes.add', { preset: 'laptop' }))

  expect(listed.ok).toBe(false)
  expect(!listed.ok && listed.error.code).toBe('PRESETS_UNREADABLE')
  expect(!added.ok && added.error.code).toBe('PRESETS_UNREADABLE')
  // Untouched: re-seeding over it is how one mistyped comma costs every edited preset.
  expect(readFileSync(presetFile(), 'utf8')).toBe(broken)
  // A pane at a size of its own needs no presets, so it still works.
  expect(await addPane({ width: 1024, height: 768 })).toMatchObject({ preset: null })
})

/**
 * A new project's panes are resolved from the presets, so a file that cannot be read
 * refuses the open rather than creating the project from a set the developer did not
 * write — those panes are snapshots, and a wrong one saved now is wrong for good.
 */
test('a presets file that cannot be read refuses to create a project rather than guessing', async () => {
  mkdirSync(sandbox.userDataDir, { recursive: true })
  writeFileSync(presetFile(), JSON.stringify({ version: 1, presets: [{ id: 'mobile' }] }))
  launched = await launchApp(sandbox)
  const shop = emptyRepo('shop')

  const run = await runCli(sandbox, ['.', '--json'], shop)

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain('PRESETS_UNREADABLE')
  // Named well enough to fix by hand: which preset, and which of its fields.
  expect(run.stderr).toContain('preset mobile')
  // Nothing was opened, and no project file was left behind for the repo.
  expect((await state()).project).toBeNull()
  expect(existsSync(join(sandbox.userDataDir, 'projects', projectFileName(shop)))).toBe(false)

  // The failure is in the event log too, where an agent already looks ([ADR-0006]).
  const run2 = await runCli(sandbox, ['logs', '--json'])
  expect(run2.stdout).toContain('PRESETS_UNREADABLE')
})

test('panes.add, panes.remove, panes.resize and panes.rotate refuse malformed params', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  await open(shop.repoPath)
  const [mobile] = shop.panes

  const refusals: Array<[string, unknown]> = [
    ['panes.add', {}],
    ['panes.add', { preset: 'laptop', width: 100, height: 100 }],
    ['panes.add', { width: 100 }],
    ['panes.add', { width: 100.5, height: 100 }],
    ['panes.add', { width: 0, height: 100 }],
    ['panes.add', { width: 1_000_000, height: 100 }],
    ['panes.add', { preset: 'laptop', colour: 'red' }],
    ['panes.remove', {}],
    ['panes.remove', { pane: mobile.id, extra: 1 }],
    ['panes.resize', { pane: mobile.id }],
    ['panes.resize', { pane: mobile.id, width: 100.5 }],
    ['panes.resize', { pane: mobile.id, width: 100, height: -1 }],
    ['panes.resize', { pane: mobile.id, width: 100, depth: 3 }],
    ['panes.rotate', {}]
  ]
  for (const [name, params] of refusals) {
    const response = await sendRaw(sandbox.socketPath, requestLine(name, params))
    expect(response.ok, `${name} ${JSON.stringify(params)}`).toBe(false)
    expect(!response.ok && response.error.code).toBe('INVALID_PARAMS')
  }

  // A preset that is not in the file is refused on its own code, not as bad params.
  const missing = await sendRaw(sandbox.socketPath, requestLine('panes.add', { preset: 'watch' }))
  expect(!missing.ok && missing.error.code).toBe('PRESET_NOT_FOUND')

  // Nothing above changed the pane set.
  expect(panesOf(await state())).toEqual(shop.panes)
})
