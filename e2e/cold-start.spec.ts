import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project,
  type StoredProject
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { startFixture, type Fixture } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type LaunchedApp } from './harness'

/**
 * The window opened without a repo ([ADR-0015]). Opened from the Dock there is no
 * `breakpoint .` to have said which project, so the window asks for a URL, and a URL
 * opens a project with no repo path: pointed at it, never stored, lost on quit.
 *
 * Where a pane ended up is read from the guest's own `location`, not from what the app
 * believes it asked for.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

function projectFiles(): string[] {
  const directory = join(sandbox.userDataDir, 'projects')
  return existsSync(directory) ? readdirSync(directory) : []
}

function saveProject(project: StoredProject): string {
  const directory = join(sandbox.userDataDir, 'projects')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, projectFileName(project.repoPath))
  writeFileSync(file, `${JSON.stringify(writeProjectFile(project), null, 2)}\n`)
  return file
}

async function paneUrls(page: Page, project: Project): Promise<string[]> {
  const app = launched!.app
  return Promise.all(
    project.panes.map(async (pane) => {
      const id = await page
        .locator(`webview[data-pane="${pane.id}"]`)
        .evaluate((element) =>
          (element as unknown as { getWebContentsId(): number }).getWebContentsId()
        )
      return app.evaluate(
        ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('location.href'),
        id
      ) as Promise<string>
    })
  )
}

async function expectPanesAt(page: Page, project: Project, url: string): Promise<void> {
  await expect
    .poll(() => paneUrls(page, project), { timeout: 20_000 })
    .toEqual(project.panes.map(() => url))
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

test('a window opened without a repo asks for a URL, and opens an unsaved project at it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  const address = page.getByTestId('project-url')
  await expect(address).toBeVisible()
  await expect(address).toHaveValue('')
  await expect(page.getByText('breakpoint .')).toHaveCount(0)

  await address.fill(`${fixture.a}/cold`)
  await address.press('Enter')

  await expect(page.getByTestId('project-unsaved')).toBeVisible()
  const { project } = await state()
  expect(project).toMatchObject({
    repoPath: null,
    startUrl: `${fixture.a}/cold`,
    allowedOrigins: [fixture.a]
  })
  await expectPanesAt(page, project!, `${fixture.a}/cold`)
  expect(projectFiles()).toEqual([])
})

test('`breakpoint open <url>` with nothing open opens the same project, and quitting loses it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  const run = await runCli(sandbox, ['open', `${fixture.b}/`, '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)

  const { project } = await state()
  expect(project).toMatchObject({ repoPath: null, allowedOrigins: [fixture.b] })
  await expectPanesAt(page, project!, `${fixture.b}/`)
  expect(projectFiles()).toEqual([])

  await closeApp(launched)
  launched = await launchApp(sandbox)
  expect((await state()).project).toBeNull()
})

test('a typed URL never matches a stored project that points at the same place', async () => {
  const repo = join(repos, 'matching-url')
  mkdirSync(repo, { recursive: true })
  const stored: StoredProject = {
    ...createProject(realpathSync.native(repo)),
    startUrl: `${fixture.a}/same`,
    allowedOrigins: [fixture.a]
  }
  const storedFile = saveProject(stored)
  const before = readFileSync(storedFile, 'utf8')

  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const address = page.getByTestId('project-url')
  await address.fill(stored.startUrl)
  await address.press('Enter')

  const { project } = await state()
  expect(project).toMatchObject({ repoPath: null, startUrl: stored.startUrl })
  await expectPanesAt(page, project!, stored.startUrl)
  expect(projectFiles()).toEqual([projectFileName(stored.repoPath)])
  expect(readFileSync(storedFile, 'utf8')).toBe(before)
})

test('opening a repo replaces an unsaved project, and names the checkout it came from', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  await runCli(sandbox, ['open', `${fixture.a}/`])
  await expect(page.getByTestId('project-unsaved')).toBeVisible()

  // Two worktrees of one repo: the directory names alone would not tell them apart.
  const checkout = join(repos, 'breakpoint', 'feature-31')
  mkdirSync(checkout, { recursive: true })
  const run = await runCli(sandbox, ['.', '--json'], checkout)
  expect(run.code).toBe(0)

  await expect(page.getByTestId('project-unsaved')).toHaveCount(0)
  await expect(page.getByTestId('project-name')).toHaveText('feature-31')
  await expect(page.getByTestId('project-checkout')).toHaveText('breakpoint/feature-31')
  await expect(page.getByTestId('project-checkout')).toHaveAttribute(
    'title',
    realpathSync.native(checkout)
  )
  expect((await state()).project?.repoPath).toBe(realpathSync.native(checkout))
  expect(projectFiles()).toHaveLength(1)
})
