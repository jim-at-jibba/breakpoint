import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Entry, LogRead } from '../src/shared/event-log'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { HIT_TARGET, startFixture, type Fixture } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type LaunchedApp } from './harness'

/**
 * Panes on the canvas, probed from outside: the CLI over the real socket, the window's
 * own DOM for what only the DOM can answer, and the main process for the guests
 * themselves. Nothing here asks the pane service to describe itself.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

/** A repo whose stored project starts on the fixture, so the panes have something real to load. */
function makeRepo(name: string, startUrl: string): Project {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project = { ...createProject(realpathSync.native(path)), startUrl }
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    JSON.stringify(writeProjectFile(project))
  )
  return project
}

async function open(project: Project): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['.', '--json'], project.repoPath)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
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

/** Waits until every pane has loaded and has been attached to or given up on. */
async function settled(project: Project): Promise<void> {
  await expect
    .poll(
      async () => {
        const [entries, snapshot] = await Promise.all([logs(), state()])
        return project.panes.every(
          (pane) =>
            ofType(entries, 'pane.loaded', pane.id).length > 0 &&
            snapshot.panes[pane.id]?.attachment !== 'pending' &&
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

test('opening a project renders its panes on a horizontal scrolling canvas, each loading the start URL', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', `${fixture.a}/`)

  await open(shop)
  await settled(shop)

  // One element per pane, in order, each drawn at its declared size: zoom is 100% until Fit lands.
  const panes = page.getByTestId('pane')
  await expect(panes).toHaveCount(3)
  expect(
    await panes.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-pane'))
    )
  ).toEqual(shop.panes.map((pane) => pane.id))
  for (const pane of shop.panes) {
    expect(await webviewBox(page, pane.id)).toEqual({ width: pane.width, height: pane.height })
  }

  // Wider than the window, so the canvas scrolls sideways rather than wrapping or squeezing.
  const canvas = page.getByTestId('canvas')
  const scroll = await canvas.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth
  }))
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth)

  // Every pane loaded the start URL, and the log says so against that pane.
  const entries = await logs()
  for (const pane of shop.panes) {
    expect(ofType(entries, 'pane.created', pane.id)).toEqual([
      expect.objectContaining({ url: `${fixture.a}/` })
    ])
    expect(ofType(entries, 'pane.attached', pane.id)).toEqual([
      expect.objectContaining({ attempt: 1 })
    ])
    expect(ofType(entries, 'pane.loaded', pane.id)[0]).toMatchObject({ url: `${fixture.a}/` })
  }
})

test('state --json prints the pane set, each pane with what is observed of it', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)

  const snapshot = await state()

  expect(snapshot.project?.panes).toEqual(shop.panes)
  expect(Object.keys(snapshot.panes)).toEqual(shop.panes.map((pane) => pane.id))
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id]).toEqual({
      attachment: 'attached',
      geometry: 'ok',
      degraded: []
    })
  }

  const text = await runCli(sandbox, ['state'])
  expect(text.stdout).toContain('Mobile    390×844 @3x\n')
  expect(text.stdout).not.toContain('degraded')
})

/**
 * Another debugger client takes every pane's guest before the app can, which is the one
 * way to refuse an attachment from outside. `release` lets go once the first load stops.
 */
async function holdEveryAttachment(app: LaunchedApp['app'], release: boolean): Promise<void> {
  await app.evaluate(({ app }, release) => {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return
      contents.debugger.attach('1.3')
      if (release) contents.once('did-stop-loading', () => contents.debugger.detach())
    })
  }, release)
}

test('a pane whose attachment fails still renders, degraded with the reason, and retries once after load only', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await holdEveryAttachment(launched.app, false)
  const shop = makeRepo('shop', `${fixture.a}/`)

  await open(shop)
  await settled(shop)

  const snapshot = await state()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id]).toEqual({
      attachment: 'failed',
      geometry: 'ok',
      degraded: [{ cause: 'attachment', message: 'Debugger is already attached to the target' }]
    })
    expect(await webviewBox(page, pane.id)).toEqual({ width: pane.width, height: pane.height })
  }
  await expect(page.locator('[data-testid="pane"][data-degraded="true"]')).toHaveCount(3)
  await expect(page.getByTestId('pane-degraded').first()).toHaveAttribute(
    'title',
    'attachment: Debugger is already attached to the target'
  )

  // A load later, nothing tries again: one retry after the first load was the whole budget.
  const before = await logs()
  await launched.app.evaluate(({ webContents }) => {
    for (const guest of webContents.getAllWebContents()) {
      if (guest.getType() === 'webview') guest.reload()
    }
  })
  await expect
    .poll(async () => ofType(await logs(), 'pane.loaded').length, { timeout: 10_000 })
    .toBe(ofType(before, 'pane.loaded').length + 3)

  const entries = await logs()
  for (const pane of shop.panes) {
    expect(
      ofType(entries, 'pane.attachFailed', pane.id).map((entry) =>
        entry.type === 'pane.attachFailed' ? [entry.attempt, entry.retrying] : []
      )
    ).toEqual([
      [1, true],
      [2, false]
    ])
    expect(ofType(entries, 'pane.attached', pane.id)).toEqual([])
  }

  const text = await runCli(sandbox, ['state'])
  expect(text.stdout).toContain('degraded: attachment: Debugger is already attached to the target')
})

test('a pane whose first attachment is refused attaches on its one retry after load', async () => {
  launched = await launchApp(sandbox)
  await holdEveryAttachment(launched.app, true)
  const shop = makeRepo('shop', `${fixture.a}/`)

  await open(shop)
  await settled(shop)
  await expect
    .poll(async () => Object.values((await state()).panes).map((status) => status.attachment))
    .toEqual(['attached', 'attached', 'attached'])

  const snapshot = await state()
  const entries = await logs()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id].degraded).toEqual([])
    expect(ofType(entries, 'pane.attachFailed', pane.id)).toEqual([
      expect.objectContaining({ attempt: 1, retrying: true })
    ])
    expect(ofType(entries, 'pane.attached', pane.id)).toEqual([
      expect.objectContaining({ attempt: 2 })
    ])
  }
})

test('a pane drawn at a size other than it declares is degraded, logged, and left at that size', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const [mobile, tablet] = shop.panes
  const { cursor } = await state()

  // The Phase 0 bug, reproduced on purpose: full width, 150px tall.
  await page
    .locator(`webview[data-pane="${mobile.id}"]`)
    .evaluate((element: HTMLElement) => (element.style.height = '150px'))

  const message = 'drawn 390×150, declared 390×844 at this zoom'
  await expect
    .poll(async () => (await state()).panes[mobile.id])
    .toEqual({
      attachment: 'attached',
      geometry: 'mismatch',
      degraded: [{ cause: 'geometry', message }]
    })
  expect((await state()).panes[tablet.id].degraded).toEqual([])
  expect(ofType(await logs(cursor), 'pane.geometryMismatch')).toEqual([
    expect.objectContaining({
      pane: mobile.id,
      expected: { width: 390, height: 844 },
      measured: { width: 390, height: 150 },
      message
    })
  ])
  await expect(
    page.locator(`[data-testid="pane"][data-pane="${mobile.id}"] [data-testid="pane-degraded"]`)
  ).toHaveAttribute('title', `geometry: ${message}`)

  // Not corrected: a mismatch means our model of the pane is wrong, and quietly resizing it
  // is how the original bug hid. Give anything that might "fix" it the time to try.
  await page.waitForTimeout(500)
  expect(await webviewBox(page, mobile.id)).toEqual({ width: 390, height: 150 })
  expect((await state()).panes[mobile.id].geometry).toBe('mismatch')

  // Put right from outside, it reads healthy again, and the log says it recovered.
  await page
    .locator(`webview[data-pane="${mobile.id}"]`)
    .evaluate((element: HTMLElement) => (element.style.height = '844px'))
  await expect.poll(async () => (await state()).panes[mobile.id].degraded).toEqual([])
  expect(ofType(await logs(cursor), 'pane.geometryMatched', mobile.id)).toHaveLength(1)
})

interface GuestReport {
  require: string
  process: string
  preloaded: string | null
  /** From the process metrics Electron keeps for the guest's own renderer process. */
  sandboxed: boolean | undefined
}

/** What a guest actually got, asked of the guest itself and of its process, never of the pane service. */
function reportGuest(app: LaunchedApp['app'], marker: string): Promise<GuestReport | null> {
  return app.evaluate(async ({ app, webContents }, marker) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview' && contents.getURL().includes(marker))
    if (!guest || guest.isLoading()) return null
    const seen = await guest.executeJavaScript(
      `({ require: typeof require, process: typeof process,
          preloaded: document.documentElement.dataset.preloaded ?? null })`
    )
    const metric = app.getAppMetrics().find((process) => process.pid === guest.getOSProcessId())
    return { ...seen, sandboxed: metric?.sandboxed }
  }, marker)
}

/** Every web contents the app has, by type: a spawned window would show up here. */
function contentsByType(app: LaunchedApp['app']): Promise<Record<string, number>> {
  return app.evaluate(({ webContents }) => {
    const counts: Record<string, number> = {}
    for (const contents of webContents.getAllWebContents()) {
      counts[contents.getType()] = (counts[contents.getType()] ?? 0) + 1
    }
    return counts
  })
}

/** Clicks the fixture's `window.open` button and its `target=_blank` link, as a user would. */
function tryToSpawnWindows(app: LaunchedApp['app'], marker: string): Promise<void> {
  return app.evaluate(async ({ webContents }, marker) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview' && contents.getURL().includes(marker))
    if (!guest) throw new Error(`no guest at ${marker}`)
    await guest.executeJavaScript(
      `document.getElementById('open').click(); document.getElementById('blank').click()`,
      true
    )
  }, marker)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('a guest that asks for a preload, node integration, no sandbox or popups gets none of them', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const [mobile] = shop.panes
  const preload = join(repos, 'preload.js')
  writeFileSync(
    preload,
    `document.addEventListener('DOMContentLoaded', () => {
       document.documentElement.dataset.preloaded = 'yes'
     })`
  )

  // The renderer asks for everything a guest must not have, on a fresh element in the
  // pane's place, under the pane's id.
  await page.locator(`webview[data-pane="${mobile.id}"]`).evaluate(
    (element, { preload, url, pane }) => {
      const hostile = document.createElement('webview')
      hostile.setAttribute('partition', 'persist:default')
      hostile.setAttribute(
        'webpreferences',
        `breakpointPane=${pane}, sandbox=no, contextIsolation=no, nodeIntegration=yes, webviewTag=yes`
      )
      hostile.setAttribute('preload', preload)
      hostile.setAttribute('nodeintegration', '')
      hostile.setAttribute('allowpopups', '')
      hostile.setAttribute('style', element.getAttribute('style') ?? '')
      hostile.setAttribute('src', url)
      element.replaceWith(hostile)
    },
    { preload: `file://${preload}`, url: `${fixture.a}/?probe=security`, pane: mobile.id }
  )

  await expect.poll(() => reportGuest(app, 'probe=security'), { timeout: 10_000 }).not.toBeNull()
  expect(await reportGuest(app, 'probe=security')).toEqual({
    require: 'undefined',
    process: 'undefined',
    preloaded: null,
    sandboxed: true
  })

  // It is still that pane's guest, so the rules for panes hold for it too.
  expect(ofType(await logs(), 'pane.created', mobile.id).at(-1)).toMatchObject({
    url: `${fixture.a}/?probe=security`
  })
  const before = await contentsByType(app)
  await tryToSpawnWindows(app, 'probe=security')
  await delay(1_000)
  expect(await contentsByType(app)).toEqual(before)
})

test('window.open and a target=_blank link inside a pane spawn no window', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const { cursor } = await state()
  const before = await contentsByType(app)
  expect(before).toEqual({ window: 1, webview: 3 })

  await tryToSpawnWindows(app, fixture.a)
  await delay(1_000)

  expect(await contentsByType(app)).toEqual(before)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(ofType(await logs(cursor), 'pane.created')).toEqual([])
})

test('pane lifecycle is in the event log, tagged with the pane, through navigation and a project switch', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const shop = makeRepo('shop', `${fixture.a}/`)
  const store = makeRepo('store', `${fixture.b}/`)
  await open(shop)
  await settled(shop)
  const [mobile] = shop.panes
  let { cursor } = await state()

  // Cross-site, so the guest swaps renderer process. The pane and its attachment carry on.
  await app.evaluate(({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview')
    return guest?.loadURL(url)
  }, `${fixture.b}/`)
  await expect
    .poll(async () => ofType(await logs(cursor), 'pane.loaded').map((entry) => entry.pane))
    .toHaveLength(1)
  const [navigated] = ofType(await logs(cursor), 'pane.loaded')
  expect(navigated).toMatchObject({ url: `${fixture.b}/` })
  expect(shop.panes.map((pane) => pane.id)).toContain(navigated.pane)
  expect((await state()).panes[mobile.id].attachment).toBe('attached')

  // Switching project ends every pane of the old one and starts every pane of the new.
  ;({ cursor } = await state())
  await open(store)
  await settled(store)
  const entries = await logs(cursor)
  expect(
    ofType(entries, 'pane.destroyed')
      .map((entry) => entry.pane)
      .sort()
  ).toEqual(shop.panes.map((pane) => pane.id).sort())
  expect(
    ofType(entries, 'pane.created')
      .map((entry) => entry.pane)
      .sort()
  ).toEqual(store.panes.map((pane) => pane.id).sort())
  expect(Object.keys((await state()).panes)).toEqual(store.panes.map((pane) => pane.id))
})

test('the fixture serves two loopback sites, a known-size hit target and hairline rules', async () => {
  const a = new URL(fixture.a)
  const b = new URL(fixture.b)
  expect([a.hostname, b.hostname]).toEqual(['127.0.0.1', 'localhost'])
  expect(a.port).not.toBe(b.port)

  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)

  // Read inside a guest, at the Mobile pane's viewport: the target sits on the bottom edge.
  const page = await launched.app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview')
    return guest?.executeJavaScript(`(() => {
      const target = document.getElementById('target').getBoundingClientRect()
      return {
        target: { width: target.width, height: target.height, bottom: target.bottom },
        viewportHeight: innerHeight,
        rules: getComputedStyle(document.body).backgroundImage
      }
    })()`)
  })
  expect(page.target).toEqual({
    width: HIT_TARGET,
    height: HIT_TARGET,
    bottom: page.viewportHeight
  })
  expect(page.rules.match(/repeating-linear-gradient/g)).toHaveLength(2)
})
