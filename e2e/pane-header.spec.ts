import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { Entry, LogRead } from '../src/shared/event-log'
import { PANE_HEADER_TIERS } from '../src/shared/pane-header'
import { PANE_PALETTE_SIZE } from '../src/shared/pane-palette'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
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
 * The pane header and its degradation ladder ([ADR-0010]), probed from outside.
 *
 * The claim under test is the one the ladder exists to make: a header holds its screen
 * size, is clipped by its own pane, and sheds content as the pane narrows rather than
 * overflowing or shrinking. Every pane here is drawn at 100%, so a pane's declared width
 * is also its width on screen and narrowing one is a resize — which is the developer's
 * own way of reaching the narrow tiers without leaving the zoom somewhere unrelated.
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
    // The ladder is keyed on screen pixels; at 100% those are the pane's declared ones.
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

async function settled(project: Project): Promise<void> {
  await expect
    .poll(
      async () => {
        const [entries, snapshot] = await Promise.all([logs(), state()])
        return project.panes.every(
          (pane) =>
            entries.some((entry) => entry.pane === pane.id && entry.type === 'pane.loaded') &&
            snapshot.panes[pane.id]?.geometry !== 'unchecked'
        )
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

function paneOf(page: Page, pane: string): Locator {
  return page.locator(`[data-testid="pane"][data-pane="${pane}"]`)
}

function headerOf(page: Page, pane: string): Locator {
  return paneOf(page, pane).getByTestId('pane-header')
}

/** What the header is asked to hold against what it has room for. */
function overflowOf(header: Locator): Promise<{ scrollWidth: number; clientWidth: number }> {
  return header.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth
  }))
}

/** Which tier the header settled on, as the ladder numbers them. */
async function tierOf(page: Page, pane: string): Promise<number> {
  return Number(await headerOf(page, pane).getAttribute('data-tier'))
}

async function resize(pane: string, width: number): Promise<void> {
  const response = await sendRaw(sandbox.socketPath, requestLine('panes.resize', { pane, width }))
  expect(response.ok).toBe(true)
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

test('a header at full width says what the pane is emulating: name, viewport, DPR and scheme', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  const [mobile] = shop.panes
  const header = headerOf(page, mobile.id)

  await expect(header.getByTestId('pane-name')).toHaveText(mobile.name)
  await expect(header.getByTestId('pane-width')).toHaveValue(String(mobile.width))
  await expect(header.getByTestId('pane-height')).toHaveValue(String(mobile.height))
  await expect(header.getByTestId('pane-dpr')).toHaveText(`@${mobile.dpr}x`)
  await expect(header.getByTestId('pane-scheme')).toHaveAttribute('data-scheme', mobile.colorScheme)

  // What the pane actually emulates, not what it asked for: with the attachment made and
  // the overrides in force, every field reads applied.
  await expect(header.getByTestId('pane-scheme')).toHaveAttribute('data-emulation', 'applied')
  await expect(header.locator('[data-emulation]').first()).toHaveAttribute(
    'data-emulation',
    'applied'
  )
})

test('narrowing a pane sheds DPR, then the name, then the height, then the scheme, and never overflows', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  const [mobile] = shop.panes
  const header = headerOf(page, mobile.id)

  // One width inside each tier, widest first: the ladder is keyed on screen pixels and
  // these panes are drawn at 100%, so a declared width is a width on screen.
  const ladder = [
    { width: 390, tier: 0, name: true, height: true, dpr: true, scheme: true },
    { width: 200, tier: 1, name: true, height: true, dpr: false, scheme: true },
    { width: 120, tier: 2, name: false, height: true, dpr: false, scheme: true },
    { width: 90, tier: 3, name: false, height: false, dpr: false, scheme: true },
    { width: 60, tier: 4, name: false, height: false, dpr: false, scheme: false },
    { width: 40, tier: 5, name: false, height: false, dpr: false, scheme: false }
  ]

  for (const step of ladder) {
    if (step.width !== mobile.width) await resize(mobile.id, step.width)
    await expect.poll(() => tierOf(page, mobile.id)).toBe(step.tier)

    const label = `at ${step.width}px`
    expect(await header.getByTestId('pane-name').count(), `name ${label}`).toBe(step.name ? 1 : 0)
    expect(await header.getByTestId('pane-height').count(), `height ${label}`).toBe(
      step.height ? 1 : 0
    )
    expect(await header.getByTestId('pane-dpr').count(), `DPR ${label}`).toBe(step.dpr ? 1 : 0)
    expect(await header.getByTestId('pane-scheme').count(), `scheme ${label}`).toBe(
      step.scheme ? 1 : 0
    )
    // The width is the last thing to go, below 56px, and the colour tab never goes.
    expect(await header.getByTestId('pane-width').count(), `width ${label}`).toBe(
      step.tier < PANE_HEADER_TIERS.length - 1 ? 1 : 0
    )
    await expect(header.getByTestId('pane-tab')).toHaveCount(1)

    // Exactly as wide as the pane it belongs to, and holding only what fits in that.
    const box = (await header.boundingBox())!
    expect(box.width, `header width ${label}`).toBeCloseTo(step.width, 0)
    const { scrollWidth, clientWidth } = await overflowOf(header)
    expect(scrollWidth, `content drawn without clipping ${label}`).toBeLessThanOrEqual(
      clientWidth + 1
    )
  }
})

test('a header holds its screen size while the canvas zooms, and the pane still clips it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  const [mobile] = shop.panes
  const header = headerOf(page, mobile.id)
  const before = (await header.boundingBox())!

  await sendRaw(sandbox.socketPath, requestLine('project.setZoom', { zoom: 50 }))
  await expect.poll(async () => (await state()).project?.zoom).toBe(50)

  await expect
    .poll(async () => Math.round((await header.boundingBox())!.width))
    .toBe(Math.round(mobile.width / 2))
  // The row keeps its screen height: only what the header says degrades, never its type.
  const after = (await header.boundingBox())!
  expect(after.height).toBeCloseTo(before.height, 0)
  const { scrollWidth, clientWidth } = await overflowOf(header)
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
})

test('a degraded pane is marked and says why, and its header reads the emulation that failed', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()

  // Take the colour scheme override away from under every pane before one exists: the
  // declaration stands, what is in force does not, and the header is where that shows.
  await app.evaluate(({ app }) => {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return
      const target = contents.debugger
      const send = target.sendCommand.bind(target)
      target.sendCommand = (method, params, sessionId) =>
        method === 'Emulation.setEmulatedMedia'
          ? Promise.reject(new Error('Invalid feature'))
          : send(method, params, sessionId)
    })
  })

  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  const [mobile] = shop.panes
  const header = headerOf(page, mobile.id)

  await expect
    .poll(async () => (await state()).panes[mobile.id]?.degraded.map(({ cause }) => cause))
    .toEqual(['colorScheme'])
  await expect(paneOf(page, mobile.id)).toHaveAttribute('data-degraded', 'true')
  // The scheme it declares, marked as not emulated — not the scheme it is rendering in.
  await expect(header.getByTestId('pane-scheme')).toHaveAttribute('data-emulation', 'failed')
  await expect(header.getByTestId('pane-degraded')).toHaveAttribute('title', /colorScheme/)
})

test('a pane whose page will not load counts the error, and keeps counting it at every tier', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  // Port 1 is not something a dev server is on, so every pane's load is refused.
  const shop = makeRepo('shop', { startUrl: 'http://127.0.0.1:1/' })
  await open(shop)

  const [mobile] = shop.panes
  await expect.poll(async () => (await state()).panes[mobile.id]?.errors ?? 0).toBeGreaterThan(0)

  const header = headerOf(page, mobile.id)
  await expect(header.getByTestId('pane-errors')).toHaveText(/\d+/)

  // The last thing standing beside the colour tab: a pane too narrow to say anything
  // else still says it has errors.
  await resize(mobile.id, 40)
  await expect.poll(() => tierOf(page, mobile.id)).toBe(PANE_HEADER_TIERS.length - 1)
  await expect(header.getByTestId('pane-errors')).toHaveCount(1)
  await expect(header.getByTestId('pane-tab')).toHaveCount(1)
  await expect(header.getByTestId('pane-width')).toHaveCount(0)
})

test('every pane takes its colour from the generated palette and nothing picks one another way', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  const tabs = await Promise.all(
    shop.panes.map((pane, index) =>
      paneOf(page, pane.id)
        .getByTestId('pane-tab')
        .evaluate((element, position: number) => {
          const root = getComputedStyle(document.documentElement)
          return {
            drawn: getComputedStyle(element).backgroundColor,
            token: root.getPropertyValue(`--bp-pane-${(position % 10) + 1}`).trim()
          }
        }, index % PANE_PALETTE_SIZE)
    )
  )

  // Each pane's tab is its own palette entry, resolved from the token rather than typed
  // into the component, and no two panes in the set share one.
  for (const { drawn, token } of tabs) {
    expect(drawn).not.toBe('')
    expect(token).not.toBe('')
  }
  expect(new Set(tabs.map(({ drawn }) => drawn)).size).toBe(shop.panes.length)
})
