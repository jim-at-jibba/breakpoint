import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { WAIT_TIMEOUT_MS } from '../src/shared/cli-surface'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
} from '../src/shared/project'
import { snapshotReadiness, type StateSnapshot } from '../src/shared/state'
import { startFixture, type Fixture } from './fixture'
import {
  closeApp,
  isRunning,
  launchApp,
  runCli,
  Sandbox,
  waitFor,
  type LaunchedApp
} from './harness'

/**
 * `breakpoint . --wait --json` is an agent's first step: it blocks until the developer's
 * panes are actually showing the page, and then prints what they are looking at (#16).
 *
 * Everything here is read from the real socket through the real command. What "ready"
 * means is one rule, declared in `snapshotReadiness` and asserted against here rather
 * than restated: the command may not resolve on a snapshot that function does not call ready.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

function makeRepo(name: string, startUrl: string): Project {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  // Drawn at 100%: what zoom does to a pane is #13's spec, not this one's.
  const project: Project = { ...createProject(realpathSync.native(path)), startUrl, zoom: 100 }
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    JSON.stringify(writeProjectFile(project))
  )
  return project
}

/** A port that was just free and is now closed: nothing will answer on it. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
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
  repos = mkdtempSync(join(tmpdir(), 'bp-repos-'))
  launched = undefined
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  rmSync(repos, { recursive: true, force: true })
})

test('--wait blocks until every pane has loaded and passed its geometry check', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.a}/`)

  // The same open without the flag answers as soon as the project is open, which is
  // before any pane has a page — the race `--wait` exists to remove.
  const eager = await runCli(sandbox, ['.', '--json'], shop.repoPath)
  expect(eager.code).toBe(0)
  expect(snapshotReadiness(JSON.parse(eager.stdout) as StateSnapshot).ready).toBe(false)

  const run = await runCli(sandbox, ['.', '--wait', '--json'], shop.repoPath)

  expect(run.code).toBe(0)
  // Safe to pipe into `jq`: the payload alone on stdout, and nothing beside it.
  const snapshot = JSON.parse(run.stdout) as StateSnapshot
  expect(run.stdout.trimEnd().split('\n')).toHaveLength(1)
  expect(run.stderr).toBe('')
  expect(snapshotReadiness(snapshot)).toEqual({ ready: true })
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id]).toMatchObject({ load: 'loaded', geometry: 'ok' })
  }
})

test('--wait against an unreachable URL exits 1 with TIMEOUT, naming the pane it waited on', async () => {
  test.setTimeout(WAIT_TIMEOUT_MS + 60_000)
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `http://127.0.0.1:${await closedPort()}/`)

  const started = Date.now()
  const run = await runCli(sandbox, ['.', '--wait', '--json'], shop.repoPath)

  expect(run.code).toBe(1)
  // A failed load is never a ready pane, however quickly it fails.
  expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_TIMEOUT_MS)
  expect(run.stdout).toBe('')
  const { error } = JSON.parse(run.stderr) as { error: { code: string; message: string } }
  expect(error.code).toBe('TIMEOUT')
  expect(error.message).toContain('could not load its page')
})

test('state --json carries the project, URL, panes, layout, zoom and cursor', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.a}/`)
  await runCli(sandbox, ['.', '--wait'], shop.repoPath)

  const run = await runCli(sandbox, ['state', '--wait', '--json'])

  expect(run.code).toBe(0)
  expect(run.stderr).toBe('')
  const snapshot = JSON.parse(run.stdout) as StateSnapshot
  expect(snapshot.project).toMatchObject({
    name: 'shop',
    repoPath: shop.repoPath,
    startUrl: `${fixture.a}/`,
    layout: 'horizontal',
    zoom: 100,
    panes: shop.panes
  })
  expect(typeof snapshot.cursor).toBe('number')
  for (const pane of shop.panes) {
    // What is actually emulated, rather than what the pane declares.
    expect(snapshot.panes[pane.id]).toEqual({
      attachment: 'attached',
      load: 'loaded',
      geometry: 'ok',
      emulation: {
        viewport: 'applied',
        userAgent: 'applied',
        touch: 'applied',
        colorScheme: 'applied'
      },
      degraded: [],
      errors: 0
    })
  }
})

test('a degraded pane is degraded in the payload, not quietly healthy', async () => {
  launched = await launchApp(sandbox)
  // Another debugger client holds every guest, so the app's own attachment is refused.
  await launched.app.evaluate(({ app }) => {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') contents.debugger.attach('1.3')
    })
  })
  const shop = makeRepo('shop', `${fixture.a}/`)

  // The pane renders and its page loads, so it is ready — degradation is not what
  // `--wait` waits for — and the payload still says exactly what is wrong with it.
  const run = await runCli(sandbox, ['.', '--wait', '--json'], shop.repoPath)

  expect(run.code).toBe(0)
  const snapshot = JSON.parse(run.stdout) as StateSnapshot
  for (const pane of shop.panes) {
    expect(snapshot.panes[pane.id]).toMatchObject({
      attachment: 'failed',
      load: 'loaded',
      geometry: 'ok',
      degraded: [{ cause: 'attachment', message: 'Debugger is already attached to the target' }]
    })
  }
})

test('--wait is a usage error on a command with no panes to wait for', async () => {
  const run = await runCli(sandbox, ['quit', '--wait', '--no-launch'])

  expect(run.code).toBe(2)
  expect(run.stdout).toBe('')
  expect(run.stderr).toContain('--wait is not a flag of quit')
  expect(isRunning(sandbox)).toBe(false)
})

test('handing a repo to a running app brings the window forward, and --background does not', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop', `${fixture.a}/`)

  const forward = await runCli(sandbox, ['.', '--verbose'], shop.repoPath)
  expect(forward.code).toBe(0)
  expect(forward.stderr).toContain('calling app.focus')

  const quiet = await runCli(sandbox, ['.', '--background', '--verbose'], shop.repoPath)
  expect(quiet.code).toBe(0)
  expect(quiet.stderr).not.toContain('app.focus')
})

test('--background starts the app when nothing is running, and the project opens', async () => {
  const shop = makeRepo('shop', `${fixture.a}/`)

  const run = await runCli(sandbox, ['.', '--background', '--wait', '--json'], shop.repoPath)

  expect(run.code).toBe(0)
  expect(isRunning(sandbox)).toBe(true)
  const snapshot = JSON.parse(run.stdout) as StateSnapshot
  expect(snapshot.project?.repoPath).toBe(shop.repoPath)
  expect(snapshotReadiness(snapshot)).toEqual({ ready: true })

  await runCli(sandbox, ['quit'])
  await waitFor(() => !isRunning(sandbox), 'the app the CLI started to exit')
})
