import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Entry, EntryOf, LogRead } from '../src/shared/event-log'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type StoredProject
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { RESOLUTION_SCRIPTS, startFixture, type Fixture } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type LaunchedApp } from './harness'

/**
 * Console capture, proved from a terminal: a real page's real console reaching the real
 * socket, tagged with the pane it came from. Nothing is drawn in this phase, so nothing
 * here looks at the window.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

test.beforeEach(async () => {
  sandbox = new Sandbox()
  launched = undefined
  repos = mkdtempSync(join(tmpdir(), 'bp-repos-'))
  fixture = await startFixture()
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repos, { recursive: true, force: true })
  await fixture.close()
})

function makeRepo(name: string, page = '/console'): StoredProject {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: StoredProject = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}${page}`
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

async function logs(): Promise<Entry[]> {
  const run = await runCli(sandbox, ['logs', '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return [...(JSON.parse(run.stdout) as LogRead).entries]
}

function messages(entries: Entry[], pane: string): EntryOf<'console.message'>[] {
  return entries.filter(
    (entry): entry is EntryOf<'console.message'> =>
      entry.type === 'console.message' && entry.pane === pane
  )
}

function exceptions(entries: Entry[], pane: string): EntryOf<'console.exception'>[] {
  return entries.filter(
    (entry): entry is EntryOf<'console.exception'> =>
      entry.type === 'console.exception' && entry.pane === pane
  )
}

/** What each pane's page says by the time it has said everything the fixture makes it say. */
async function everythingSaid(project: StoredProject): Promise<Entry[]> {
  let entries: Entry[] = []
  await expect
    .poll(
      async () => {
        entries = await logs()
        return project.panes.every(
          (pane) =>
            exceptions(entries, pane.id).length === 2 &&
            messages(entries, pane.id).some((entry) => entry.source !== 'console') &&
            messages(entries, pane.id).some((entry) => entry.text === 'at error')
        )
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  return entries
}

/**
 * Every `.enable` any pane's attachment is asked for, whoever asks: what "no other domain
 * is enabled anywhere" is checked against.
 */
async function recordEnables(
  app: LaunchedApp['app'],
  { refuseOverrides, refuse = [] }: { refuseOverrides: boolean; refuse?: string[] }
): Promise<void> {
  await app.evaluate(
    ({ app }, [refuseOverrides, refuse]) => {
      const enabled: string[] = []
      Reflect.set(globalThis, '__enabled', enabled)
      app.on('web-contents-created', (_event, contents) => {
        if (contents.getType() !== 'webview') return
        const target = contents.debugger
        const send = target.sendCommand.bind(target)
        target.sendCommand = (method, params, sessionId) => {
          if (method.endsWith('.enable')) enabled.push(method)
          if (refuse.includes(method) || (refuseOverrides && method.startsWith('Emulation.'))) {
            return Promise.reject(new Error(`${method} refused by the test`))
          }
          return send(method, params, sessionId)
        }
      })
    },
    [refuseOverrides, refuse] as const
  )
}

function enabled(app: LaunchedApp['app']): Promise<string[]> {
  return app.evaluate(() => Reflect.get(globalThis, '__enabled') as string[])
}

test('every pane reports its console, exceptions and browser messages, tagged with the pane', async () => {
  launched = await launchApp(sandbox)
  await recordEnables(launched.app, { refuseOverrides: false })
  const shop = makeRepo('shop')
  await open(shop)
  const entries = await everythingSaid(shop)
  const page = `${fixture.a}/console`
  const script = `${fixture.a}/console.js`

  for (const pane of shop.panes) {
    const said = messages(entries, pane.id).filter((entry) => entry.source === 'console')
    // Logged by the page's first script, before anything else of its own had run — and
    // nothing from Electron's own world, whose security warning is about the app.
    expect(said).toEqual([
      expect.objectContaining({
        level: 'log',
        text: "first words 42 {id: 7, name: 'Ada'} Array(2) [1, 2]",
        args: ['first %s', 'words', '42', "{id: 7, name: 'Ada'}", 'Array(2) [1, 2]'],
        url: null,
        location: expect.objectContaining({ url: page, line: 7, resolution: 'failed' })
      }),
      expect.objectContaining({ level: 'debug', text: 'at debug' }),
      expect.objectContaining({ level: 'info', text: 'at info' }),
      expect.objectContaining({ level: 'warn', text: 'at warn' }),
      expect.objectContaining({ level: 'error', text: 'at error' })
    ])

    const [thrown, rejected] = [
      exceptions(entries, pane.id).find((entry) => !entry.rejection),
      exceptions(entries, pane.id).find((entry) => entry.rejection)
    ]
    expect(thrown).toMatchObject({
      text: 'Uncaught TypeError: thrown at every width',
      error: 'TypeError: thrown at every width',
      location: { url: script, line: 3, resolution: 'failed' }
    })
    expect(thrown?.stack[0]).toMatchObject({ function: 'explode', url: script, line: 3 })
    expect(rejected).toMatchObject({
      text: 'Uncaught (in promise) Error: nobody caught this',
      error: 'Error: nobody caught this'
    })

    // The browser's own account of the refused request, with no Network domain to hear it.
    const browser = messages(entries, pane.id).filter((entry) => entry.source !== 'console')
    expect(browser).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          source: 'javascript',
          text: expect.stringContaining(
            `Access to fetch at '${fixture.b}/not-shared' from origin '${fixture.a}' has been blocked by CORS policy`
          )
        }),
        expect.objectContaining({
          level: 'error',
          source: 'network',
          text: 'Failed to load resource: net::ERR_FAILED',
          url: `${fixture.b}/not-shared`
        })
      ])
    )
  }

  // Runtime and Log, once for each pane's one attachment, and nothing else anywhere.
  expect((await enabled(launched.app)).sort()).toEqual(
    [...shop.panes.flatMap(() => ['Log.enable', 'Runtime.enable'])].sort()
  )

  const text = await runCli(sandbox, ['logs'])
  const [first] = shop.panes
  expect(text.stdout).toContain(`  ${first.id}  error at error at ${fixture.a}/console:11:`)
  expect(text.stdout).toContain(
    `  ${first.id}  error Uncaught TypeError: thrown at every width at ${script}:3:`
  )
})

test('a pane whose every override is refused still reports its console', async () => {
  launched = await launchApp(sandbox)
  await recordEnables(launched.app, { refuseOverrides: true })
  const shop = makeRepo('shop')
  await open(shop)
  await everythingSaid(shop)

  const snapshot = await state()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id].degraded.map((degradation) => degradation.cause).sort()).toEqual(
      ['colorScheme', 'touch', 'userAgent', 'viewport']
    )
  }
})

test('a pane whose console cannot be enabled is degraded rather than quiet', async () => {
  launched = await launchApp(sandbox)
  await recordEnables(launched.app, { refuseOverrides: false, refuse: ['Runtime.enable'] })
  const shop = makeRepo('shop')
  await open(shop)

  await expect
    .poll(
      async () => {
        const snapshot = await state()
        return shop.panes.map((pane) => snapshot.panes[pane.id]?.degraded ?? [])
      },
      { timeout: 20_000 }
    )
    .toEqual(
      shop.panes.map(() => [
        { cause: 'console', message: 'Runtime.enable: Runtime.enable refused by the test' }
      ])
    )
  const entries = await logs()
  for (const pane of shop.panes) {
    expect(entries).toContainEqual(
      expect.objectContaining({ pane: pane.id, type: 'pane.consoleFailed' })
    )
    // The page's own calls and exceptions are Runtime's, and Runtime was refused.
    expect(exceptions(entries, pane.id)).toEqual([])
    expect(messages(entries, pane.id).filter((entry) => entry.source === 'console')).toEqual([])
  }
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

test('a pane that attached on its second attempt still has what was logged before its scripts ran', async () => {
  launched = await launchApp(sandbox)
  await holdEveryAttachment(launched.app, true)
  const shop = makeRepo('shop')
  await open(shop)
  const entries = await everythingSaid(shop)

  for (const pane of shop.panes) {
    expect(entries).toContainEqual(
      expect.objectContaining({ pane: pane.id, type: 'pane.attached', attempt: 2 })
    )
    // Everything the page logged had been logged before the attachment existed, so all of
    // it is `Runtime.enable`'s replay — whose objects V8 no longer has previews for.
    expect(
      messages(entries, pane.id)
        .filter((entry) => entry.source === 'console')
        .map((entry) => entry.text)
    ).toEqual(['first words 42 Object Array(2)', 'at debug', 'at info', 'at warn', 'at error'])
  }
})

test('a pane whose attachment failed is degraded and reports nothing', async () => {
  launched = await launchApp(sandbox)
  await holdEveryAttachment(launched.app, false)
  const shop = makeRepo('shop')
  await open(shop)

  await expect
    .poll(
      async () => {
        const entries = await logs()
        return shop.panes.every(
          (pane) =>
            entries.filter(
              (entry) =>
                entry.pane === pane.id && entry.type === 'pane.attachFailed' && !entry.retrying
            ).length === 1
        )
      },
      { timeout: 20_000 }
    )
    .toBe(true)

  const snapshot = await state()
  const entries = await logs()
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id].degraded).toEqual([
      { cause: 'attachment', message: 'Debugger is already attached to the target' }
    ])
    expect(entries.filter((entry) => entry.type.startsWith('console.'))).toEqual([])
  }
})

/** What each pane's page says by the time `/resolution` has said everything it says. */
async function resolutionSaid(panes: readonly string[]): Promise<Entry[]> {
  let entries: Entry[] = []
  await expect
    .poll(
      async () => {
        entries = await logs()
        return panes.every(
          (pane) =>
            exceptions(entries, pane).length === 1 &&
            messages(entries, pane).filter((entry) => entry.source === 'console').length === 2
        )
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  return entries
}

test('a dev server script resolves to its path in the repo, and a bundle says it did not', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', '/resolution')
  mkdirSync(join(shop.repoPath, 'src'))
  writeFileSync(join(shop.repoPath, 'src', 'widget.js'), RESOLUTION_SCRIPTS['/src/widget.js'])
  await open(shop)
  const entries = await resolutionSaid(shop.panes.map((pane) => pane.id))
  const widget = `${fixture.a}/src/widget.js`
  const bundle = `${fixture.a}/assets/bundle-3f9a.js`

  for (const pane of shop.panes) {
    const [thrown] = exceptions(entries, pane.id)
    expect(thrown.location).toEqual({
      url: widget,
      line: 2,
      column: expect.any(Number),
      resolution: 'resolved',
      path: 'src/widget.js'
    })
    // Every frame on its own: the repo's resolve, and the bundle's keep what they came with.
    expect(thrown.stack).toEqual([
      expect.objectContaining({
        function: 'inner',
        line: 2,
        resolution: 'resolved',
        path: 'src/widget.js'
      }),
      expect.objectContaining({
        function: 'outer',
        line: 5,
        resolution: 'resolved',
        path: 'src/widget.js'
      }),
      expect.objectContaining({
        function: 'bundled',
        url: bundle,
        line: 2,
        resolution: 'failed',
        path: null
      })
    ])

    const said = messages(entries, pane.id).filter((entry) => entry.source === 'console')
    expect(said).toEqual([
      expect.objectContaining({
        text: 'warned from the repo',
        location: expect.objectContaining({
          line: 8,
          resolution: 'resolved',
          path: 'src/widget.js'
        })
      }),
      expect.objectContaining({
        text: 'logged from a bundle',
        location: { url: bundle, line: 1, column: 9, resolution: 'failed', path: null }
      })
    ])
  }

  // Resolution happened before the append: nothing arrived twice, nothing was rewritten.
  const cursors = entries.map((entry) => entry.cursor)
  expect(new Set(cursors).size).toBe(cursors.length)

  const text = await runCli(sandbox, ['logs'])
  const [first] = shop.panes
  expect(text.stdout).toContain(
    `  ${first.id}  error Uncaught RangeError: thrown from the repo at src/widget.js:2:`
  )
  expect(text.stdout).toContain(`  ${first.id}  info logged from a bundle at ${bundle}:1:9`)
})

test('a project with no repo path keeps logging, with every location unresolved', async () => {
  launched = await launchApp(sandbox)
  const run = await runCli(sandbox, ['open', `${fixture.a}/resolution`, '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  const { project } = await state()
  expect(project?.repoPath).toBeNull()

  const entries = await resolutionSaid(project!.panes.map((pane) => pane.id))
  const locations = entries.flatMap((entry) =>
    entry.type === 'console.message' || entry.type === 'console.exception'
      ? [entry.location, ...entry.stack]
      : []
  )
  expect(locations.length).toBeGreaterThan(0)
  for (const location of locations) {
    expect(location).toMatchObject({ resolution: 'failed', path: null })
  }
})
