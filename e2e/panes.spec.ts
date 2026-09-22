import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import type { Entry, LogRead } from '../src/shared/event-log'
import { PATCH_CHANNEL, ROUTE_CHANNEL } from '../src/shared/ipc'
import type { RouteResponse } from '../src/shared/protocol'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { HIT_TARGET, startFixture, type Fixture } from './fixture'
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
 * Panes on the canvas, probed from outside: the CLI over the real socket, the window's
 * own DOM for what only the DOM can answer, and the main process for the guests
 * themselves. Nothing here asks the pane service to describe itself.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

/**
 * A repo whose stored project starts on the fixture, so the panes have something real to
 * load. Drawn at 100%: what zoom does to a pane is #13's spec, and every assertion here
 * is about the pane rather than about the canvas it sits on.
 */
function makeRepo(name: string, startUrl: string): Project {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: Project = { ...createProject(realpathSync.native(path)), startUrl, zoom: 100 }
  saveProject(project)
  return project
}

function saveProject(project: Project): void {
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    JSON.stringify(writeProjectFile(project))
  )
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

  // One element per pane, in order, each drawn at its declared size at this project's 100%.
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
    expect(snapshot.panes[pane.id]).toMatchObject({
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
async function holdEveryAttachment({
  app,
  release
}: {
  app: LaunchedApp['app']
  release: boolean
}): Promise<void> {
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
  await holdEveryAttachment({ app: launched.app, release: false })
  const shop = makeRepo('shop', `${fixture.a}/`)

  await open(shop)
  await settled(shop)

  const snapshot = await state()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id]).toEqual({
      attachment: 'failed',
      geometry: 'ok',
      // Nothing can be emulated without the attachment, so nothing claims to be.
      emulation: {
        viewport: 'pending',
        userAgent: 'pending',
        touch: 'pending',
        colorScheme: 'pending'
      },
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
  await holdEveryAttachment({ app: launched.app, release: true })
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
    .toMatchObject({
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

  const preferences = await app.evaluateHandle(({ BrowserWindow }) => ({
    hardened: new Promise<{
      webSecurity: boolean | undefined
      allowRunningInsecureContent: boolean | undefined
    }>((resolve) => {
      BrowserWindow.getAllWindows()[0].webContents.once(
        'will-attach-webview',
        (_event, preferences) => {
          resolve({
            webSecurity: preferences.webSecurity,
            allowRunningInsecureContent: preferences.allowRunningInsecureContent
          })
        }
      )
    })
  }))

  // The renderer asks for everything a guest must not have, on a fresh element in the
  // pane's place, under the pane's id.
  await page.locator(`webview[data-pane="${mobile.id}"]`).evaluate(
    (element, { preload, url, pane }) => {
      const hostile = document.createElement('webview')
      hostile.setAttribute('partition', 'persist:default')
      hostile.setAttribute(
        'webpreferences',
        `breakpointPane=${pane}, sandbox=no, contextIsolation=no, nodeIntegration=yes, webviewTag=yes, webSecurity=no, allowRunningInsecureContent=yes`
      )
      hostile.setAttribute('preload', preload)
      hostile.setAttribute('nodeintegration', '')
      hostile.setAttribute('allowpopups', '')
      hostile.setAttribute('style', element.getAttribute('style') ?? '')
      hostile.setAttribute('src', url)
      element.replaceWith(hostile)
    },
    { preload: pathToFileURL(preload).href, url: `${fixture.a}/?probe=security`, pane: mobile.id }
  )

  expect(await preferences.evaluate(({ hardened }) => hardened)).toEqual({
    webSecurity: true,
    allowRunningInsecureContent: false
  })
  await preferences.dispose()
  await expect.poll(() => reportGuest(app, 'probe=security'), { timeout: 10_000 }).not.toBeNull()
  expect(await reportGuest(app, 'probe=security')).toEqual({
    require: 'undefined',
    process: 'undefined',
    preloaded: null,
    sandboxed: true
  })

  const cors = await app.evaluate(async ({ webContents }, other: string): Promise<string> => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes('probe=security'))
    if (!guest) throw new Error('security guest missing')
    return guest.executeJavaScript(`fetch(${JSON.stringify(other)}).then(
      () => 'readable', error => error.name
    )`)
  }, fixture.b)
  expect(cors).toBe('TypeError')

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

test('a pane whose page cannot load logs that it failed, and never that it loaded', async () => {
  launched = await launchApp(sandbox)
  // A port that was just free and is now closed: nothing will answer on it.
  const closed = await new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
  const shop = makeRepo('shop', `http://127.0.0.1:${closed}/`)

  await open(shop)
  await expect
    .poll(async () => ofType(await logs(), 'pane.loadFailed').length, { timeout: 10_000 })
    .toBe(3)
  // Chromium finishes loading its own error page after a failure. That is not the pane loading.
  await delay(1_000)

  const entries = await logs()
  for (const pane of shop.panes) {
    expect(ofType(entries, 'pane.loadFailed', pane.id)).toEqual([
      expect.objectContaining({ url: `http://127.0.0.1:${closed}/`, code: -102 })
    ])
    expect(ofType(entries, 'pane.loaded', pane.id)).toEqual([])
  }
})

test('unknown and prototype-named pane ids return PANE_NOT_FOUND without changing state or logs', async () => {
  launched = await launchApp(sandbox)
  expect(
    await sendRaw(
      sandbox.socketPath,
      requestLine('panes.reportGeometry', {
        pane: 'toString',
        expected: { width: 1, height: 1 },
        measured: { width: 1, height: 1 }
      })
    )
  ).toEqual({
    id: 'test',
    ok: false,
    error: { code: 'PANE_NOT_FOUND', message: 'no pane toString in the open project' }
  })
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const before = await state()

  for (const pane of ['missing', '__proto__', 'constructor', 'toString']) {
    const response = await sendRaw(
      sandbox.socketPath,
      requestLine('panes.reportGeometry', {
        pane,
        expected: { width: 390, height: 844 },
        measured: { width: 390, height: 844 }
      })
    )
    expect(response).toEqual({
      id: 'test',
      ok: false,
      error: { code: 'PANE_NOT_FOUND', message: `no pane ${pane} in the open project` }
    })
  }
  expect(await state()).toEqual(before)
  expect(await logs(before.cursor)).toEqual([])
})

test('guest permission checks and requests are denied on shared and isolated sessions', async () => {
  launched = await launchApp(sandbox)
  const original = makeRepo('shop', `${fixture.a}/`)
  const shop: Project = {
    ...original,
    sessions: [...original.sessions, { id: 'isolated', name: 'Isolated' }],
    panes: original.panes.map((pane, index) =>
      index === 0 ? { ...pane, session: 'isolated' } : pane
    )
  }
  saveProject(shop)
  await open(shop)
  await settled(shop)

  const permissions = await launched.app.evaluate(async ({ webContents }) => {
    const guests = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
    return Promise.all(
      guests.map((guest) =>
        guest.executeJavaScript(`(async () => ({
      checked: (await navigator.permissions.query({ name: 'notifications' })).state,
      requested: await Notification.requestPermission()
    }))()`)
      )
    )
  })
  expect(permissions).toEqual(
    Array.from({ length: 3 }, () => ({ checked: 'denied', requested: 'denied' }))
  )
})

test('a renderer cannot attach a guest with a non-HTTP(S) source', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const before = await contentsByType(app)
  const local = join(repos, 'local.html')
  writeFileSync(local, '<!doctype html><title>forbidden</title>')

  for (const src of [
    pathToFileURL(local).href,
    'data:text/html,forbidden',
    'about:blank',
    'javascript:alert(1)',
    'breakpoint://open'
  ]) {
    const attachment = await app.evaluateHandle(({ BrowserWindow }) => ({
      refused: new Promise<boolean>((resolve) => {
        BrowserWindow.getAllWindows()[0].webContents.once('will-attach-webview', (event) => {
          resolve(event.defaultPrevented)
        })
      })
    }))
    await page.evaluate(
      ({ src, pane }: { src: string; pane: string }): void => {
        const element = document.createElement('webview')
        element.setAttribute('data-probe', 'forbidden')
        element.setAttribute('webpreferences', `breakpointPane=${pane}`)
        element.setAttribute('src', src)
        document.body.append(element)
      },
      { src, pane: shop.panes[0].id }
    )
    expect(await attachment.evaluate(({ refused }) => refused)).toBe(true)
    await attachment.dispose()
    await page.locator('[data-probe="forbidden"]').evaluate((element) => element.remove())
    expect(await contentsByType(app)).toEqual(before)
  }
})

for (const scheme of ['file', 'data', 'about'] as const) {
  test(`an attached guest blocks ${scheme}: URLs from loadURL and webview.src`, async () => {
    launched = await launchApp(sandbox)
    const { app } = launched
    const page = await app.firstWindow()
    const shop = makeRepo('shop', `${fixture.a}/`)
    await open(shop)
    await settled(shop)
    const local = join(repos, 'local.html')
    writeFileSync(local, '<!doctype html><title>forbidden</title>')
    const urls: Record<typeof scheme, string> = {
      file: pathToFileURL(local).href,
      data: 'data:text/html,<title>forbidden</title>',
      about: 'about:blank'
    }
    const url = urls[scheme]
    const outcome = await app.evaluate(async ({ webContents }, url: string) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview')
      if (!guest) throw new Error('guest missing')
      const result = await guest.loadURL(url).then(
        () => 'loaded',
        () => 'blocked'
      )
      return { result, url: guest.getURL() }
    }, url)
    expect(outcome).toEqual({ result: 'blocked', url: `${fixture.a}/` })

    const refused = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('Pane navigation requires')
    })
    await page
      .locator('webview')
      .first()
      .evaluate((element, url: string) => element.setAttribute('src', url), url)
    await refused

    expect(
      await app.evaluate(({ webContents }) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getType() === 'webview')
        return guest?.getURL()
      })
    ).toBe(`${fixture.a}/`)
  })
}

test('guest redirects reject local files and still allow another HTTP origin', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const local = join(repos, 'local.html')
  writeFileSync(local, '<!doctype html><title>forbidden</title>')

  const blocked = await launched.app.evaluate(
    async ({ webContents }, url: string): Promise<string> => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview')
      if (!guest) throw new Error('guest missing')
      return guest.loadURL(url).then(
        () => 'loaded',
        () => 'blocked'
      )
    },
    `${fixture.a}/redirect?to=${encodeURIComponent(pathToFileURL(local).href)}`
  )
  expect(blocked).toBe('blocked')

  const navigated = await launched.app.evaluate(
    async ({ webContents }, url: string): Promise<string> => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview')
      if (!guest) throw new Error('guest missing')
      await guest.loadURL(url)
      return guest.getURL()
    },
    `${fixture.a}/redirect?to=${encodeURIComponent(`${fixture.b}/after-redirect`)}`
  )
  expect(navigated).toBe(`${fixture.b}/after-redirect`)
})

test('page navigation blocks non-HTTP(S) documents while embedded data and blob resources still work', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  const navigation = await app.evaluateHandle(({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview')
    if (!guest) throw new Error('guest missing')
    return {
      refused: new Promise<boolean>((resolve) =>
        guest.once('will-navigate', (event) => resolve(event.defaultPrevented))
      )
    }
  })
  await app.evaluate(async ({ webContents }): Promise<void> => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview')
    if (!guest) throw new Error('guest missing')
    await guest.executeJavaScript(`location.href = URL.createObjectURL(
      new Blob(['<title>forbidden</title>'], { type: 'text/html' })
    )`)
  })
  expect(await navigation.evaluate(({ refused }) => refused)).toBe(true)
  await navigation.dispose()

  const resources = await app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview')
    if (!guest) throw new Error('guest missing')
    return {
      url: guest.getURL(),
      values: await guest.executeJavaScript(`(async () => {
        const blob = URL.createObjectURL(new Blob(['blob resource']))
        try {
          return await Promise.all([
            fetch('data:text/plain,data%20resource').then(response => response.text()),
            fetch(blob).then(response => response.text())
          ])
        } finally {
          URL.revokeObjectURL(blob)
        }
      })()`)
    }
  })
  expect(resources).toEqual({ url: `${fixture.a}/`, values: ['data resource', 'blob resource'] })
})

interface GuestPageState {
  id: number
  url: string
  history: string[]
  draft: string
}

function guestPageStates(app: LaunchedApp['app']): Promise<GuestPageState[]> {
  return app.evaluate(async ({ webContents }) => {
    const guests = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
    return Promise.all(
      guests.map(async (guest): Promise<GuestPageState> => ({
        id: guest.id,
        url: guest.getURL(),
        history: guest.navigationHistory.getAllEntries().map((entry) => entry.url),
        draft: await guest.executeJavaScript('document.getElementById("draft").value')
      }))
    )
  })
}

test('snapshot refresh, failure, and retry preserve guest identity, history, navigation, and unsaved forms', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop', `${fixture.a}/`)
  await open(shop)
  await settled(shop)
  await app.evaluate(async ({ webContents }, other: string): Promise<void> => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview')
    if (!guest) throw new Error('guest missing')
    await guest.loadURL(`${other}/form`)
    await guest.executeJavaScript('document.getElementById("draft").value = "unsaved draft"')
  }, fixture.b)
  const before = await guestPageStates(app)
  const snapshot = await state()
  const refresh = await app.evaluateHandle(({ ipcMain }, channel: string) => {
    const { promise, resolve } = Promise.withResolvers<RouteResponse<StateSnapshot>>()
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => promise)
    return {
      fail: (): void =>
        resolve({
          id: 'test',
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'snapshot unavailable' }
        })
    }
  }, ROUTE_CHANNEL)
  await app.evaluate(
    ({ BrowserWindow }, { channel, snapshot }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(channel, [
        {
          revision: snapshot.revision + 2,
          patch: { type: 'project.opened', project: snapshot.project }
        }
      ])
    },
    { channel: PATCH_CHANNEL, snapshot }
  )

  await expect(page.getByRole('status')).toHaveText('Refreshing project…')
  expect(await guestPageStates(app)).toEqual(before)
  await refresh.evaluate(({ fail }) => fail())
  await refresh.dispose()
  await expect(page.getByRole('alert')).toContainText('snapshot unavailable')
  expect(await guestPageStates(app)).toEqual(before)

  await app.evaluate(
    ({ ipcMain }, { channel, snapshot }) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => ({ id: 'test', ok: true, data: snapshot }))
    },
    { channel: ROUTE_CHANNEL, snapshot }
  )
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveCount(0)
  expect(await guestPageStates(app)).toEqual(before)
  expect(ofType(await logs(snapshot.cursor), 'pane.destroyed')).toEqual([])
})
