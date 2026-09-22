import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type JSHandle, type Page } from '@playwright/test'
import type { Entry, LogRead } from '../src/shared/event-log'
import type { PaneStatus } from '../src/shared/panes'
import type { EmulationSetting } from '../src/shared/routes'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
} from '../src/shared/project'
import type { RevisionedPatch, StateSnapshot } from '../src/shared/state'
import {
  HIT_TARGET,
  SCHEME_SWATCH,
  startFixture,
  SWATCH,
  type Fixture,
  type RecordedRequest
} from './fixture'
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
 * Emulation, confirmed from outside the page's own account of itself. ADR-0004 is the
 * standing warning: CDP reports the emulated viewport whether or not anything renders
 * it, so nothing here rests on `innerWidth`. The evidence is input landing where it
 * should, the requests a server receives, and pixels read off the raster.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

function makeRepo(name: string, changes: Partial<Project> = {}): Project {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: Project = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}/`,
    // Drawn at 100% unless a test says otherwise: what emulation does is not the canvas's.
    zoom: 100,
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

async function open(project: Project): Promise<void> {
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

const ALL_APPLIED: PaneStatus['emulation'] = {
  viewport: 'applied',
  userAgent: 'applied',
  touch: 'applied',
  colorScheme: 'applied'
}

/** Every pane loaded, attached, measured, and emulation reported one way or the other. */
async function settled(project: Project): Promise<void> {
  await expect
    .poll(
      async () => {
        const [entries, snapshot] = await Promise.all([logs(), state()])
        return project.panes.every((pane) => {
          const status = snapshot.panes[pane.id]
          return (
            ofType(entries, 'pane.loaded', pane.id).length > 0 &&
            status?.attachment === 'attached' &&
            status.geometry !== 'unchecked' &&
            Object.values(status.emulation).every((capability) => capability !== 'pending')
          )
        })
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

/** The guest's `webContents` id, asked of the pane's own element. */
function guestId(page: Page, pane: string): Promise<number> {
  return page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
}

function inGuest<T>(app: LaunchedApp['app'], id: number, script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script),
    { id, script }
  ) as Promise<T>
}

interface MediaControl {
  count(): number
  complete(index: number): void
  refuse(index: number): void
}

interface HoldMediaOptions {
  app: LaunchedApp['app']
  id: number
  mode: 'command' | 'response'
}

function holdMedia({ app, id, mode }: HoldMediaOptions): Promise<JSHandle<MediaControl>> {
  return app.evaluateHandle(
    ({ webContents }, { id, mode }) => {
      const target = webContents.fromId(id)!.debugger
      const send = target.sendCommand.bind(target)
      const held: Array<{ complete(): void; refuse(): void }> = []
      target.sendCommand = (
        method: string,
        params?: object,
        sessionId?: string
      ): Promise<unknown> => {
        if (method !== 'Emulation.setEmulatedMedia') return send(method, params, sessionId)
        return new Promise<unknown>((resolve, reject) => {
          const refuse = (): void => reject(new Error('obsolete media failure'))
          if (mode === 'command') {
            held.push({
              complete: (): void => {
                void send(method, params, sessionId).then(resolve, reject)
              },
              refuse
            })
          } else {
            void send(method, params, sessionId).then((value: unknown): void => {
              held.push({ complete: (): void => resolve(value), refuse })
            }, reject)
          }
        })
      }
      return {
        count: (): number => held.length,
        complete: (index: number): void => held[index].complete(),
        refuse: (index: number): void => held[index].refuse()
      }
    },
    { id, mode }
  )
}

/** The centre pixel of the scheme swatch, read off the guest's own raster. */
function swatchColour(app: LaunchedApp['app'], id: number, width: number): Promise<number[]> {
  return app.evaluate(
    async ({ webContents }, { id, rect }) => {
      const image = await webContents.fromId(id)!.capturePage(rect)
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
      // BGRA on every platform Electron ships.
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
    },
    { id, rect: { x: width - SWATCH, y: 0, width: SWATCH, height: SWATCH } }
  )
}

function documents(origin: string): RecordedRequest[] {
  return fixture
    .requests()
    .filter((request) => request.origin === origin && request.url.split('?')[0] === '/')
}

function assets(): RecordedRequest[] {
  return fixture.requests().filter((request) => request.url.startsWith('/asset'))
}

/** How a server doing device detection decides it is talking to a phone (MDN's advice). */
function looksLikePhone(request: RecordedRequest): boolean {
  return /Mobi/.test(String(request.headers['user-agent']))
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

test('a pane drawn at half size lays its page out at its declared viewport, edge to edge', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', { zoom: 50 })
  await open(shop)
  await settled(shop)

  for (const pane of shop.panes) {
    const webview = page.locator(`webview[data-pane="${pane.id}"]`)
    await webview.evaluate((element) => element.scrollIntoView({ inline: 'end', block: 'end' }))
    const box = await webview.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    })
    // Drawn at half its declared size, host-side.
    expect({ width: box.width, height: box.height }).toEqual({
      width: pane.width / 2,
      height: pane.height / 2
    })

    // A real click a few screen pixels inside the drawn bottom-right corner lands on the
    // page's bottom-right target, so the page's right and bottom edges are the pane's. The
    // target is HIT_TARGET CSS px, so half that on screen; aim well inside it. Retried,
    // because a guest's hit-test regions follow a host scroll a frame or so late; a page
    // laid out at the wrong width would never be hit however often it was clicked.
    const id = await guestId(page, pane.id)
    const inset = HIT_TARGET / 8
    await expect(async () => {
      await page.mouse.click(box.x + box.width - inset, box.y + box.height - inset)
      const hits = await inGuest<string>(
        launched!.app,
        id,
        `document.getElementById('corner').dataset.hits`
      )
      expect(Number(hits), `${pane.name}'s bottom-right target`).toBeGreaterThan(0)
    }).toPass({ timeout: 5_000 })
  }
})

test('each pane requests the image its device pixel ratio implies', async () => {
  launched = await launchApp(sandbox)
  const before = assets().length
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  // Mobile @3x, Tablet @2x, Desktop @1x: one of each variant, and nothing else.
  const requested = assets()
    .slice(before)
    .map((request) => request.url)
    .sort()
  expect(requested).toEqual(['/asset?x=1', '/asset?x=2', '/asset?x=3'])
  expect(shop.panes.map((pane) => pane.dpr)).toEqual([3, 2, 1])
})

test('a mobile pane is a phone to the server, with client hints that agree, and a desktop pane is not', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const before = documents(fixture.a).length
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile, , desktop] = shop.panes

  // The very first request each pane makes, as the server saw it.
  const requests = documents(fixture.a).slice(before)
  expect(requests).toHaveLength(3)
  const phones = requests.filter(looksLikePhone)
  // Mobile and Tablet carry the mobile flag; Desktop does not.
  expect(phones).toHaveLength(2)
  for (const request of phones) expect(request.headers['user-agent']).toMatch(/Android/)
  const [computer] = requests.filter((request) => !looksLikePhone(request))
  expect(computer.headers['user-agent']).toMatch(/Macintosh/)
  for (const request of requests) {
    expect(request.headers['user-agent']).not.toMatch(/Electron|breakpoint/i)
  }

  // Chromium sends Sec-CH-UA headers over HTTPS only, and the fixture is loopback HTTP,
  // so the hints are read where the page reads them. They must tell the server's story.
  const hints = `navigator.userAgentData.getHighEntropyValues(['platform', 'fullVersionList'])
    .then(({ mobile, platform, brands }) => ({ mobile, platform, chromium: brands.some(b => b.brand === 'Chromium') }))`
  expect(await inGuest(app, await guestId(page, mobile.id), hints)).toEqual({
    mobile: true,
    platform: 'Android',
    chromium: true
  })
  expect(await inGuest(app, await guestId(page, desktop.id), hints)).toEqual({
    mobile: false,
    platform: 'macOS',
    chromium: true
  })
})

/** A real touch, sent over the pane's attachment, counted by the page's own listener. */
async function touchesReceived(app: LaunchedApp['app'], id: number): Promise<number> {
  await inGuest(
    app,
    id,
    `window.touches = 0; document.addEventListener('touchstart', () => window.touches++); true`
  )
  await app.evaluate(async ({ webContents }, id) => {
    const attachment = webContents.fromId(id)!.debugger
    await attachment.sendCommand('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 10, y: 10 }]
    })
    await attachment.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }, id)
  return inGuest(app, id, 'window.touches')
}

test('a mobile pane emulates touch, and a desktop pane has it disabled without the call being refused', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  const before = documents(fixture.a).length
  await open(shop)
  await settled(shop)
  const [mobile, , desktop] = shop.panes

  const probe = `({
    touchAtStart: document.documentElement.dataset.touchAtStart,
    touchEvent: 'ontouchstart' in window,
    points: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: none)').matches
  })`
  const phone = await guestId(page, mobile.id)
  expect(await inGuest(app, phone, probe)).toEqual({
    touchAtStart: 'true',
    touchEvent: true,
    points: 5,
    coarse: true,
    hover: true
  })
  expect(await touchesReceived(app, phone)).toBe(1)
  expect(await inGuest(app, phone, 'document.documentElement.dataset.initialTouches')).toBe('1')
  expect(await inGuest(app, await guestId(page, desktop.id), probe)).toEqual({
    touchAtStart: 'false',
    touchEvent: false,
    points: 0,
    coarse: false,
    hover: false
  })

  const snapshot = await state()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id]).toMatchObject({ emulation: ALL_APPLIED, degraded: [] })
  }
  expect(ofType(await logs(), 'pane.emulationFailed')).toEqual([])
  expect(documents(fixture.a).slice(before)).toHaveLength(shop.panes.length)
  expect(
    await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.navigationHistory.canGoBack(),
      phone
    )
  ).toBe(false)
})

test('a saved scheme stays pending on both surfaces until the new override is applied', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile] = shop.panes
  const id = await guestId(page, mobile.id)
  const dark = await inGuest<boolean>(app, id, `matchMedia('(prefers-color-scheme: dark)').matches`)
  const colorScheme = dark ? 'light' : 'dark'
  const held = await holdMedia({ app, id, mode: 'command' })
  const received = await page.evaluateHandle(() => {
    const patches: RevisionedPatch[] = []
    const dispose = window.breakpoint.onPatches((batch) => patches.push(...batch))
    return { patches, dispose }
  })
  const setting: EmulationSetting = { pane: mobile.id, colorScheme }
  const response = await page.evaluate(
    async (setting: EmulationSetting) => window.breakpoint.invoke('panes.setEmulation', setting),
    setting
  )
  expect(response).toMatchObject({
    ok: true,
    data: {
      pane: {
        colorScheme,
        status: { emulation: { ...ALL_APPLIED, colorScheme: 'pending' } }
      }
    }
  })
  expect((await state()).panes[mobile.id].emulation).toEqual({
    ...ALL_APPLIED,
    colorScheme: 'pending'
  })
  expect(await inGuest(app, id, `matchMedia('(prefers-color-scheme: dark)').matches`)).toBe(dark)
  await expect
    .poll(() => received.evaluate(({ patches }) => patches.map(({ patch }) => patch.type)))
    .toEqual(['pane.status', 'pane.changed'])

  await held.evaluate((control) => control.complete(0))
  await expect.poll(async () => (await state()).panes[mobile.id].emulation).toEqual(ALL_APPLIED)
  expect(await inGuest(app, id, `matchMedia('(prefers-color-scheme: dark)').matches`)).toBe(!dark)
  await expect
    .poll(() => received.evaluate(({ patches }) => patches.map(({ patch }) => patch.type)))
    .toEqual(['pane.status', 'pane.changed', 'pane.status'])
  expect(await received.evaluate(({ patches }) => patches[0].patch)).toMatchObject({
    type: 'pane.status',
    pane: mobile.id,
    status: { emulation: { colorScheme: 'pending' } }
  })
  await received.evaluate(({ dispose }) => dispose())
  await received.dispose()
  await held.dispose()
})

test('obsolete emulation answers cannot complete or degrade the latest setting', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile] = shop.panes
  const held = await holdMedia({ app, id: await guestId(page, mobile.id), mode: 'response' })
  const { cursor } = await state()
  for (const colorScheme of ['dark', 'light', 'system'] as const) {
    expect(
      await sendRaw(
        sandbox.socketPath,
        requestLine('panes.setEmulation', { pane: mobile.id, colorScheme })
      )
    ).toMatchObject({ ok: true })
  }
  await expect.poll(() => held.evaluate((control) => control.count())).toBe(3)
  await held.evaluate((control) => control.complete(0))
  expect((await state()).panes[mobile.id].emulation.colorScheme).toBe('pending')

  await held.evaluate((control) => control.complete(2))
  await expect.poll(async () => (await state()).panes[mobile.id].emulation).toEqual(ALL_APPLIED)
  await held.evaluate((control) => control.refuse(1))
  expect((await state()).panes[mobile.id]).toMatchObject({ emulation: ALL_APPLIED, degraded: [] })
  expect((await logs(cursor)).map((entry) => entry.type)).toEqual([
    'pane.emulationChanged',
    'pane.emulationChanged',
    'pane.emulationChanged'
  ])
  await held.dispose()
})

test('two panes render the same page light and dark, and neither follows the app’s appearance', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile, tablet] = shop.panes
  const { cursor } = await state()

  for (const [pane, colorScheme] of [
    [mobile, 'dark'],
    [tablet, 'light']
  ] as const) {
    const response = await sendRaw(
      sandbox.socketPath,
      requestLine('panes.setEmulation', { pane: pane.id, colorScheme })
    )
    expect(response).toMatchObject({ ok: true, data: { pane: { id: pane.id, colorScheme } } })
  }

  const dark = await guestId(page, mobile.id)
  const light = await guestId(page, tablet.id)
  for (const themeSource of ['dark', 'light', 'system'] as const) {
    await app.evaluate(({ nativeTheme }, source) => {
      nativeTheme.themeSource = source
    }, themeSource)
    await expect
      .poll(() => swatchColour(app, dark, mobile.width), {
        message: `dark pane, app ${themeSource}`
      })
      .toEqual([...SCHEME_SWATCH.dark])
    await expect
      .poll(() => swatchColour(app, light, tablet.width), {
        message: `light pane, app ${themeSource}`
      })
      .toEqual([...SCHEME_SWATCH.light])
  }

  // Declared, kept, and recorded against each pane.
  const snapshot = await state()
  expect(snapshot.project?.panes.map((pane) => pane.colorScheme)).toEqual([
    'dark',
    'light',
    'system'
  ])
  expect(
    ofType(await logs(cursor), 'pane.emulationChanged').map((entry) => [
      entry.pane,
      entry.type === 'pane.emulationChanged' && entry.changes
    ])
  ).toEqual([
    [mobile.id, { colorScheme: 'dark' }],
    [tablet.id, { colorScheme: 'light' }]
  ])
  const text = await runCli(sandbox, ['logs', '--since', String(cursor)])
  expect(text.stdout).toContain('emulation set: colorScheme dark')
})

test('overrides survive a cross-origin navigation and its process swap, with no reload and nothing to report', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile] = shop.panes
  await sendRaw(
    sandbox.socketPath,
    requestLine('panes.setEmulation', { pane: mobile.id, colorScheme: 'dark' })
  )
  const id = await guestId(page, mobile.id)
  await expect.poll(() => swatchColour(app, id, mobile.width)).toEqual([...SCHEME_SWATCH.dark])

  const { cursor } = await state()
  const beforeAssets = assets().length
  const beforeDocuments = documents(fixture.b).length
  const pid = await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)!.getOSProcessId(),
    id
  )

  await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)!.loadURL(url), {
    id,
    url: `${fixture.b}/`
  })

  // A genuine swap: a different site is a different renderer process.
  expect(
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getOSProcessId(), id)
  ).not.toBe(pid)
  // Still a phone to the new server, still asking for 3x, still dark on screen.
  const [request] = documents(fixture.b).slice(beforeDocuments)
  expect(looksLikePhone(request)).toBe(true)
  await expect
    .poll(() =>
      assets()
        .slice(beforeAssets)
        .map((asset) => asset.url)
    )
    .toEqual(['/asset?x=3'])
  await expect.poll(() => swatchColour(app, id, mobile.width)).toEqual([...SCHEME_SWATCH.dark])
  expect(
    await inGuest(app, id, `({ points: navigator.maxTouchPoints, host: location.host })`)
  ).toEqual({ points: 5, host: new URL(fixture.b).host })

  // One load, one document request: nothing reloaded to put the overrides back.
  const entries = await logs(cursor)
  expect(ofType(entries, 'pane.loaded', mobile.id)).toEqual([
    expect.objectContaining({ url: `${fixture.b}/` })
  ])
  expect(documents(fixture.b).slice(beforeDocuments)).toHaveLength(1)
  expect(entries.filter((entry) => entry.type.startsWith('pane.emulation'))).toEqual([])
  expect((await state()).panes[mobile.id]).toMatchObject({ emulation: ALL_APPLIED, degraded: [] })
})

test('a refused override degrades that one capability, leaves the rest applied, and records why', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  // The #4 mistake, made on purpose: zero touch points, which CDP refuses even when
  // disabling touch. Every other command reaches CDP untouched.
  await app.evaluate(({ app }) => {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return
      const target = contents.debugger
      const send = target.sendCommand.bind(target)
      target.sendCommand = (method, params, sessionId) =>
        send(
          method,
          method === 'Emulation.setTouchEmulationEnabled'
            ? { ...params, maxTouchPoints: 0 }
            : params,
          sessionId
        )
    })
  })
  const before = documents(fixture.a).length
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  const snapshot = await state()
  const entries = await logs()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id].emulation).toEqual({ ...ALL_APPLIED, touch: 'failed' })
    expect(snapshot.panes[pane.id].degraded).toEqual([
      { cause: 'touch', message: expect.stringContaining('Touch points must be between 1 and 16') }
    ])
    // Recorded once, not again on the navigation reapply.
    expect(ofType(entries, 'pane.emulationFailed', pane.id)).toEqual([
      expect.objectContaining({ capability: 'touch' })
    ])
  }
  await expect(page.locator('[data-testid="pane"][data-degraded="true"]')).toHaveCount(3)

  // The rest held: the phones are still phones to the server.
  expect(documents(fixture.a).slice(before).filter(looksLikePhone)).toHaveLength(2)
  const text = await runCli(sandbox, ['state'])
  expect(text.stdout).toContain('degraded: touch: ')
})

test('panes.setEmulation refuses malformed settings and unknown panes, changing nothing', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile] = shop.panes
  const before = await state()

  for (const [params, message] of [
    [undefined, 'this route takes { pane } and at least one of colorScheme, dpr, mobile, touch'],
    [
      { pane: mobile.id },
      'this route takes { pane } and at least one of colorScheme, dpr, mobile, touch'
    ],
    [
      { pane: mobile.id, scheme: 'dark' },
      'this route takes { pane } and at least one of colorScheme, dpr, mobile, touch, not scheme'
    ],
    [{ pane: mobile.id, colorScheme: 'sepia' }, 'colorScheme must be light, dark or system'],
    [{ pane: mobile.id, dpr: 0 }, 'dpr must be a finite number above 0'],
    [{ pane: mobile.id, mobile: 'yes' }, 'mobile must be true or false'],
    [{ pane: mobile.id, touch: 'yes' }, 'touch must be true or false'],
    [{ colorScheme: 'dark' }, 'pane must be a non-empty string']
  ] as const) {
    expect(await sendRaw(sandbox.socketPath, requestLine('panes.setEmulation', params))).toEqual({
      id: 'test',
      ok: false,
      error: { code: 'INVALID_PARAMS', message }
    })
  }
  for (const pane of ['missing', '__proto__', 'constructor']) {
    expect(
      await sendRaw(
        sandbox.socketPath,
        requestLine('panes.setEmulation', { pane, colorScheme: 'dark' })
      )
    ).toEqual({
      id: 'test',
      ok: false,
      error: { code: 'PANE_NOT_FOUND', message: `no pane ${pane} in the open project` }
    })
  }
  expect(await state()).toEqual(before)
  expect(await logs(before.cursor)).toEqual([])
})
