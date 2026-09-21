import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PATCH_CHANNEL, ROUTE_CHANNEL } from '../src/shared/ipc'
import { PROJECT_FILE_VERSION, projectFileName, type Project } from '../src/shared/project'
import type { LogRead } from '../src/shared/event-log'
import type { PatchBatch, StateSnapshot } from '../src/shared/state'
import {
  closeApp,
  isRunning,
  launchApp,
  MAIN_ENTRY,
  runCli,
  Sandbox,
  waitFor,
  type LaunchedApp
} from './harness'

/**
 * Projects, probed from outside: the CLI over the real socket, the files it leaves in
 * the user data directory, and the window's own DOM. Nothing here asks a service to
 * describe itself.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string

function projectsDir(): string {
  return join(sandbox.userDataDir, 'projects')
}

function projectFiles(): string[] {
  return existsSync(projectsDir()) ? readdirSync(projectsDir()) : []
}

/** A throwaway repo directory. Canonical, so it can be compared with what the app stores. */
function makeRepo(name: string): string {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  return realpathSync.native(path)
}

async function openProject(path: string): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['.', '--json'], path)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

async function shownProject(page: Page): Promise<{ name: string; url: string }> {
  return {
    name: (await page.getByTestId('project-name').textContent()) ?? '',
    url: (await page.getByTestId('project-url').textContent()) ?? ''
  }
}

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

test('breakpoint . in a repo with no project creates one and the window shows it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  expect(projectFiles()).toEqual([])

  const snapshot = await openProject(shop)

  expect(snapshot.project).toMatchObject({
    name: 'shop',
    repoPath: shop,
    startUrl: 'http://localhost:3000',
    layout: 'horizontal',
    zoom: 'fit'
  })
  expect(snapshot.project?.panes).toHaveLength(3)
  expect(projectFiles()).toEqual([projectFileName(shop)])

  await expect(page.getByTestId('project-name')).toHaveText('shop')
  await expect(page.getByTestId('project-url')).toHaveText('http://localhost:3000')
})

test('breakpoint . with nothing running starts the app and opens the project', async () => {
  const shop = makeRepo('shop')

  const run = await runCli(sandbox, ['.'], shop)

  expect(run.code).toBe(0)
  expect(run.stdout).toContain(`Opened shop (${shop})`)
  expect(run.stdout).toContain('Mobile')
  expect(isRunning(sandbox)).toBe(true)
  expect(projectFiles()).toHaveLength(1)

  const quit = await runCli(sandbox, ['quit'])
  expect(quit.code).toBe(0)
  await waitFor(() => !isRunning(sandbox), 'the launched app to exit')
})

test('breakpoint . --no-launch with nothing running exits 3, starts nothing and creates nothing', async () => {
  const shop = makeRepo('shop')

  const run = await runCli(sandbox, ['.', '--no-launch', '--json'], shop)

  expect(run.code).toBe(3)
  expect(run.stdout).toBe('')
  expect(JSON.parse(run.stderr).error.code).toBe('APP_NOT_RUNNING')
  expect(isRunning(sandbox)).toBe(false)
  expect(projectFiles()).toEqual([])
})

test('running it again in the same repo reopens the same project, not a second one', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')

  const first = await openProject(shop)
  const second = await openProject(shop)

  // Pane ids are minted at creation, so equal ids mean the file was read, not recreated.
  expect(second.project?.panes.map((pane) => pane.id)).toEqual(
    first.project?.panes.map((pane) => pane.id)
  )
  expect(projectFiles()).toHaveLength(1)
})

test('the same repo reached by a different but equivalent path is the same project', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  mkdirSync(join(shop, 'packages'))
  const link = join(repos, 'shop-link')
  symlinkSync(shop, link)

  const direct = await openProject(shop)
  const viaDots = await runCli(sandbox, ['packages/..', '--json'], shop)
  const viaLink = await runCli(sandbox, ['./shop-link/', '--json'], repos)

  for (const run of [viaDots, viaLink]) {
    expect(run.code).toBe(0)
    const snapshot = JSON.parse(run.stdout) as StateSnapshot
    expect(snapshot.project?.repoPath).toBe(shop)
    expect(snapshot.project?.panes.map((pane) => pane.id)).toEqual(
      direct.project?.panes.map((pane) => pane.id)
    )
  }
  expect(projectFiles()).toHaveLength(1)
})

test('quitting and reopening restores the stored project', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  const before = await openProject(shop)
  await closeApp(launched)
  launched = undefined

  // Nothing can change a project yet, so the only stored state a restart could lose is
  // what creation minted. Pane ids are random at creation and must come back verbatim.
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await expect(page.getByTestId('project-name')).toHaveCount(0)

  const after = await openProject(shop)

  expect(after.project).toEqual(before.project)
  expect(await shownProject(page)).toEqual({ name: 'shop', url: 'http://localhost:3000' })
})

test('a file from a newer build refuses to load, says so, and is left untouched', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  mkdirSync(projectsDir(), { recursive: true })
  const file = join(projectsDir(), projectFileName(shop))
  const written = JSON.stringify({
    version: PROJECT_FILE_VERSION + 1,
    project: { name: 'from the future', hologram: true }
  })
  writeFileSync(file, written)

  const run = await runCli(sandbox, ['.', '--json'], shop)

  expect(run.code).toBe(1)
  expect(run.stdout).toBe('')
  const { error } = JSON.parse(run.stderr)
  expect(error.code).toBe('PROJECT_UNREADABLE')
  expect(error.message).toContain(`file version ${PROJECT_FILE_VERSION + 1}`)
  expect(error.details).toEqual({ reason: 'newer', file })
  expect(readFileSync(file, 'utf8')).toBe(written)

  const state = await runCli(sandbox, ['state', '--json'])
  expect((JSON.parse(state.stdout) as StateSnapshot).project).toBeNull()
})

test('a corrupt project file does not prevent other projects from opening', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  const store = makeRepo('store')
  mkdirSync(projectsDir(), { recursive: true })
  const file = join(projectsDir(), projectFileName(shop))
  writeFileSync(file, '{ "version": 1, "project": ')

  const corrupt = await runCli(sandbox, ['.', '--json'], shop)
  expect(corrupt.code).toBe(1)
  const { error } = JSON.parse(corrupt.stderr)
  expect(error.code).toBe('PROJECT_UNREADABLE')
  expect(error.details.reason).toBe('corrupt')
  expect(readFileSync(file, 'utf8')).toBe('{ "version": 1, "project": ')

  const snapshot = await openProject(store)
  expect(snapshot.project?.name).toBe('store')
  expect(projectFiles().sort()).toEqual([projectFileName(shop), projectFileName(store)].sort())
})

test('a path that is not a directory is INVALID_PARAMS, not a new project', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  writeFileSync(join(shop, 'README.md'), '# shop\n')

  const missing = await runCli(sandbox, ['./nope', '--json'], shop)
  const file = await runCli(sandbox, ['./README.md', '--json'], shop)

  for (const run of [missing, file]) {
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(JSON.parse(run.stderr).error.code).toBe('INVALID_PARAMS')
  }
  expect(projectFiles()).toEqual([])
})

test('a project file with another repo identity is refused without changing the open project', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  const other = makeRepo('other')
  const before = await openProject(shop)
  const written = readFileSync(join(projectsDir(), projectFileName(shop)), 'utf8')
  const file = join(projectsDir(), projectFileName(other))
  writeFileSync(file, written)

  const refused = await runCli(sandbox, ['.', '--json'], other)
  expect(refused.code).toBe(1)
  expect(JSON.parse(refused.stderr).error).toMatchObject({
    code: 'PROJECT_UNREADABLE',
    details: { reason: 'corrupt', file }
  })
  expect(readFileSync(file, 'utf8')).toBe(written)
  const state = await runCli(sandbox, ['state', '--json'])
  // The open is untouched. The refusal is itself an observation, logged against no pane;
  // the panes keep observing too, so the cursor is not asserted to have moved by one.
  const after = JSON.parse(state.stdout) as StateSnapshot
  expect(after.project).toEqual(before.project)
  expect(Object.keys(after.panes)).toEqual(Object.keys(before.panes))
  const logs = await runCli(sandbox, ['logs', '--since', String(before.cursor), '--json'])
  const refusals = (JSON.parse(logs.stdout) as LogRead).entries.filter(
    (entry) => entry.type === 'project.openFailed'
  )
  expect(refusals).toEqual([expect.objectContaining({ pane: null, path: other })])
  await expect(page.getByTestId('project-name')).toHaveText('shop')
})

test('the renderer shows a snapshot failure and recovers over the real preload bridge', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const snapshot = await openProject(makeRepo('shop'))
  await expect(page.getByTestId('project-name')).toHaveText('shop')
  await app.evaluate(
    ({ ipcMain, BrowserWindow }, { route, patch, snapshot }) => {
      ipcMain.removeHandler(route)
      ipcMain.handle(route, () => ({
        id: 'test',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'snapshot unavailable' }
      }))
      BrowserWindow.getAllWindows()[0].webContents.send(patch, [
        {
          revision: snapshot.revision + 2,
          patch: { type: 'project.opened', project: snapshot.project }
        }
      ])
    },
    { route: ROUTE_CHANNEL, patch: PATCH_CHANNEL, snapshot }
  )
  await expect(page.getByRole('alert')).toContainText('snapshot unavailable')
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()

  await app.evaluate(
    ({ ipcMain }, { route, snapshot }) => {
      ipcMain.removeHandler(route)
      ipcMain.handle(route, () => ({ id: 'test', ok: true, data: snapshot }))
    },
    { route: ROUTE_CHANNEL, snapshot }
  )
  await expect(page.getByTestId('project-name')).toHaveText('shop')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('state with nothing open says so on both outputs', async () => {
  launched = await launchApp(sandbox)

  const json = await runCli(sandbox, ['state', '--json'])
  const text = await runCli(sandbox, ['state'])

  expect(json.code).toBe(0)
  expect(JSON.parse(json.stdout)).toEqual({ revision: 0, cursor: 0, project: null, panes: {} })
  // The cursor is printed with nothing open: that is when the log matters most.
  expect(text.stdout).toBe('No project is open. Run `breakpoint .` in a repo.\nCursor 0\n')
})

test('the renderer renders from a snapshot plus patches, and re-fetches on a desync', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  const snapshot = await openProject(shop)
  await expect(page.getByTestId('project-name')).toHaveText('shop')

  const phantom: Project = { ...(snapshot.project as Project), name: 'phantom' }
  const push = (batch: PatchBatch): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, [channel, payload]) => {
        BrowserWindow.getAllWindows()[0].webContents.send(channel, payload)
      },
      [PATCH_CHANNEL, batch] as const
    )

  // A contiguous patch is applied: the window believes the push channel.
  await push([
    { revision: snapshot.revision + 1, patch: { type: 'project.opened', project: phantom } }
  ])
  await expect(page.getByTestId('project-name')).toHaveText('phantom')

  // A gap is a desync. Nothing in the gapped batch is applied; the snapshot is re-fetched
  // wholesale from the app, which never heard of any phantom.
  await push([
    {
      revision: snapshot.revision + 5,
      patch: { type: 'project.opened', project: { ...phantom, name: 'gapped' } }
    }
  ])
  await expect(page.getByTestId('project-name')).toHaveText('shop')
})

test('a second launch pointed at a repo opens that project in the running app', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')

  const second = spawn(launched.app.process().spawnfile, [MAIN_ENTRY, shop], {
    env: sandbox.env,
    stdio: 'ignore'
  })
  await new Promise<void>((resolve) => second.once('close', () => resolve()))

  await expect(page.getByTestId('project-name')).toHaveText('shop')
  const state = await runCli(sandbox, ['state', '--json'])
  expect((JSON.parse(state.stdout) as StateSnapshot).project?.repoPath).toBe(shop)
})

test('a native macOS open-file request opens the repo and recreates a closed window', async () => {
  test.skip(process.platform !== 'darwin', 'macOS keeps the app alive after its window closes')
  launched = await launchApp(sandbox)
  const { app } = launched
  const shop = makeRepo('shop')
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.once('closed', () => resolve())
        window.close()
      })
  )
  const [page, prevented] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ app }, path) => {
      let prevented = false
      app.emit(
        'open-file',
        {
          preventDefault: (): void => {
            prevented = true
          }
        },
        path
      )
      return prevented
    }, shop)
  ])
  expect(prevented).toBe(true)
  await expect(page.getByTestId('project-name')).toHaveText('shop')
  const state = await runCli(sandbox, ['state', '--json'])
  expect(JSON.parse(state.stdout).project.repoPath).toBe(shop)
})
