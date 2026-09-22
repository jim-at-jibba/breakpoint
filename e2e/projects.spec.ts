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
  requestLine,
  runCli,
  Sandbox,
  sendRaw,
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

/**
 * The snapshot once every pane has been attached to or given up on, has been measured,
 * and has reported its emulation if it has an attachment to emulate over, after which
 * nothing announces a change on its own. Tests that forge patches number them
 * from this revision; one taken at open is overtaken by the panes' own status patches.
 *
 * The revision must also hold across two polls. Patches reach the window a frame after
 * the app publishes them, so a snapshot read the instant the last one is published is
 * ahead of the window, and a patch forged from it would look like a gap.
 */
async function quietSnapshot(): Promise<StateSnapshot> {
  let snapshot: StateSnapshot | undefined
  let previous: number | undefined
  await expect
    .poll(async () => {
      const run = await runCli(sandbox, ['state', '--json'])
      snapshot = JSON.parse(run.stdout) as StateSnapshot
      const held = snapshot.revision === previous
      previous = snapshot.revision
      return (
        held &&
        Object.values(snapshot.panes).every(
          (status) =>
            status.attachment !== 'pending' &&
            status.geometry !== 'unchecked' &&
            (status.attachment === 'failed' ||
              Object.values(status.emulation).every((capability) => capability !== 'pending'))
        )
      )
    })
    .toBe(true)
  return snapshot as StateSnapshot
}

async function shownProject(page: Page): Promise<{ name: string; url: string }> {
  return {
    name: (await page.getByTestId('project-name').textContent()) ?? '',
    url: await page.getByTestId('project-url').inputValue()
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
  await expect(page.getByTestId('project-url')).toHaveValue('http://localhost:3000')
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
  await openProject(makeRepo('shop'))
  await expect(page.getByTestId('project-name')).toHaveText('shop')
  const snapshot = await quietSnapshot()
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
  expect(JSON.parse(json.stdout)).toEqual({
    revision: 0,
    cursor: 0,
    project: null,
    panes: {},
    // Certificate trust is the app's, not a project's, so it is there with nothing open.
    certificates: { trusted: [], waiting: [] }
  })
  // The cursor is printed with nothing open: that is when the log matters most.
  expect(text.stdout).toBe('No project is open. Run `breakpoint .` in a repo.\nCursor 0\n')
})

test('the renderer renders from a snapshot plus patches, and re-fetches on a desync', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await openProject(shop)
  await expect(page.getByTestId('project-name')).toHaveText('shop')
  const snapshot = await quietSnapshot()

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

/**
 * The project switcher (#19, PRD J3): the list, and what choosing one does.
 *
 * Everything here is probed through the window, because the switcher is a surface and
 * not a service. What it causes is read back over the CLI, which reaches the same route
 * table it does.
 */

/** Opens the switcher on its shortcut and waits for the list to have been read. */
async function openSwitcher(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p')
  await expect(page.getByTestId('project-list')).toBeVisible()
  await expect(page.getByTestId('project-option').first()).toBeVisible()
}

/** What the switcher lists, in the order it lists it: each entry's repo path or file. */
function listedProjects(page: Page): Promise<string[]> {
  return page
    .getByTestId('project-option')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-project') ?? '')
    )
}

async function chooseProject(page: Page, project: string): Promise<void> {
  await page.locator(`[data-testid="project-option"][data-project="${project}"]`).click()
}

/** The pane ids the canvas is drawing, which is how a swapped pane set is visible. */
function drawnPanes(page: Page): Promise<string[]> {
  return page
    .locator('webview[data-pane]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-pane') ?? ''))
}

test('the switcher opens on its shortcut and lists every stored project', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  const admin = makeRepo('admin')
  await openProject(shop)
  await openProject(admin)

  await openSwitcher(page)

  expect(await listedProjects(page)).toEqual([admin, shop])
  await expect(page.getByTestId('project-switcher-message')).toHaveCount(0)
})

test('two worktrees of one repo are told apart by the segment above them, with the whole path to hover', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  // What a git worktree checkout looks like: one repo, two directories, and a basename
  // that names the worktree rather than the repo.
  const main = makeRepo(join('breakpoint', 'main'))
  const feature = makeRepo(join('breakpoint', 'feature-19'))
  await openProject(main)
  await openProject(feature)

  await openSwitcher(page)

  const options = page.getByTestId('project-option')
  await expect(options.nth(0)).toContainText('breakpoint/feature-19')
  await expect(options.nth(0)).toHaveAttribute('title', feature)
  await expect(options.nth(1)).toContainText('breakpoint/main')
  await expect(options.nth(1)).toHaveAttribute('title', main)
})

test('choosing a project swaps panes, layout, zoom and URL without a restart, and switching back restores the first as it was left', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  const admin = makeRepo('admin')

  // Shop is left somewhere a freshly created project never is: on a different layout, a
  // different zoom and a different URL from the defaults admin will be created with.
  const opened = await openProject(shop)
  const shopPanes = opened.project?.panes.map((pane) => pane.id) ?? []
  await sendRaw(sandbox.socketPath, requestLine('project.setZoom', { zoom: 50 }))
  await sendRaw(
    sandbox.socketPath,
    requestLine('project.setLayout', { layout: 'focus', focusedPane: shopPanes[2] })
  )
  await sendRaw(
    sandbox.socketPath,
    requestLine('project.navigate', { url: 'http://localhost:3000/checkout' })
  )
  const created = await openProject(admin)
  const adminPanes = created.project?.panes.map((pane) => pane.id) ?? []
  await expect(page.getByTestId('project-name')).toHaveText('admin')

  await openSwitcher(page)
  await chooseProject(page, shop)

  await expect(page.getByTestId('project-name')).toHaveText('shop')
  await expect(page.getByTestId('project-url')).toHaveValue('http://localhost:3000/checkout')
  await expect.poll(() => drawnPanes(page)).toEqual(shopPanes)
  expect((await quietSnapshot()).project).toMatchObject({
    repoPath: shop,
    layout: 'focus',
    focusedPane: shopPanes[2],
    zoom: 50,
    startUrl: 'http://localhost:3000/checkout'
  })

  // Away, and back: the first project comes back as it was left, from its own file.
  await openSwitcher(page)
  await chooseProject(page, admin)
  await expect(page.getByTestId('project-name')).toHaveText('admin')
  await expect.poll(() => drawnPanes(page)).toEqual(adminPanes)
  await openSwitcher(page)
  await chooseProject(page, shop)

  await expect(page.getByTestId('project-name')).toHaveText('shop')
  await expect.poll(() => drawnPanes(page)).toEqual(shopPanes)
  expect((await quietSnapshot()).project).toMatchObject({
    layout: 'focus',
    focusedPane: shopPanes[2],
    zoom: 50,
    startUrl: 'http://localhost:3000/checkout'
  })
  // One app throughout: nothing restarted to get from one project to the other.
  expect(launched.app.process().exitCode).toBeNull()
})

test('a project whose file refuses to load is listed, reports why when chosen, and does not break the list', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  const future = makeRepo('future')
  await openProject(shop)
  writeFileSync(
    join(projectsDir(), projectFileName(future)),
    JSON.stringify({
      version: PROJECT_FILE_VERSION + 1,
      project: { name: 'future', repoPath: future, hologram: true }
    })
  )

  await openSwitcher(page)

  expect(await listedProjects(page)).toEqual([future, shop])
  await expect(
    page.locator(`[data-testid="project-option"][data-project="${future}"]`)
  ).toHaveAttribute('data-openable', 'false')

  await chooseProject(page, future)

  await expect(page.getByTestId('project-switcher-message')).toContainText(
    `file version ${PROJECT_FILE_VERSION + 1}`
  )
  // The list is still the list, and the open project is untouched by the refusal.
  expect(await listedProjects(page)).toEqual([future, shop])
  await chooseProject(page, shop)
  await expect(page.getByTestId('project-list')).toHaveCount(0)
  await expect(page.getByTestId('project-name')).toHaveText('shop')
})

test('the list is the project directory, not an index kept beside it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  const store = makeRepo('store')
  await openProject(store)
  await openProject(shop)
  const file = join(projectsDir(), projectFileName(store))
  const written = readFileSync(file, 'utf8')

  // Nothing is told the file has gone; the next read of the directory is what says so.
  rmSync(file)
  await openSwitcher(page)
  expect(await listedProjects(page)).toEqual([shop])

  await page.keyboard.press('Escape')
  writeFileSync(file, written)
  await openSwitcher(page)
  expect(await listedProjects(page)).toEqual([shop, store])
})
