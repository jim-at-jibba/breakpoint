import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { Entry, LogRead } from '../src/shared/event-log'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type StoredProject
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { startFixture, type Fixture } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type LaunchedApp } from './harness'

/**
 * Clear, the display floor and preserving the log (#77, [ADR-0022]), probed in the real
 * window. Clear hides what the window has seen and touches nothing anyone else reads: the
 * log, `breakpoint logs --since 0` and every pane's error count are as they were.
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

function makeRepo(name: string): StoredProject {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: StoredProject = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}/`
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

async function everything(): Promise<readonly Entry[]> {
  const run = await runCli(sandbox, ['logs', '--since', '0', '--json'])
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as LogRead).entries
}

async function consoleEntries(): Promise<Entry[]> {
  const run = await runCli(sandbox, ['logs', '--json'])
  expect(run.code).toBe(0)
  return (JSON.parse(run.stdout) as LogRead).entries.filter((entry) =>
    entry.type.startsWith('console.')
  )
}

async function attached(project: StoredProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const { panes } = await state()
        return project.panes.every((pane) => panes[pane.id]?.attachment === 'attached')
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

async function inPane(page: Page, pane: string, script: string): Promise<void> {
  const id = await page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
  await launched!.app.evaluate(
    ({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script),
    { id, script }
  )
}

function rows(page: Page): Locator {
  return page.getByTestId('console-row')
}

function errorCounts(snapshot: StateSnapshot, project: StoredProject): number[] {
  return project.panes.map((pane) => snapshot.panes[pane.id]?.errors ?? -1)
}

test('Clear empties the console and leaves the log, every reader and every count alone', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)

  for (const pane of shop.panes) {
    await inPane(page, pane.id, `console.error('broken in ${pane.id}'); 0`)
  }
  await expect.poll(async () => (await consoleEntries()).length).toBe(shop.panes.length)
  await expect(rows(page)).not.toHaveCount(0)
  const before = await everything()
  const counts = errorCounts(await state(), shop)
  expect(counts.every((count) => count >= 1)).toBe(true)

  await page.getByTestId('console-clear').click()

  await expect(rows(page)).toHaveCount(0)
  expect(await everything()).toEqual(before)
  const after = await state()
  expect(errorCounts(after, shop)).toEqual(counts)
  expect(after.console.floor).toBeGreaterThanOrEqual(before.at(-1)!.cursor)

  // What arrives after it shows.
  await inPane(page, shop.panes[0].id, `console.log('after the clear'); 0`)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).getByTestId('console-message')).toHaveText('after the clear')

  // The floor is the snapshot's, so a reloaded window draws from where it was cleared.
  await page.reload()
  await expect(page.getByTestId('console-scroller')).toHaveAttribute('data-status', 'live')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).getByTestId('console-message')).toHaveText('after the clear')
})

test('by default an error logged during a reload is still shown after it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)
  const pane = shop.panes[0].id

  await expect(page.getByTestId('console-preserve-log')).toHaveAttribute('aria-pressed', 'true')
  await inPane(page, pane, `console.error('dying words'); setTimeout(() => location.reload()); 0`)
  await expect.poll(async () => (await consoleEntries()).length).toBe(1)
  await expect
    .poll(async () => (await everything()).filter((entry) => entry.type === 'pane.loaded').length, {
      timeout: 20_000
    })
    .toBeGreaterThan(shop.panes.length)
  await attached(shop)
  await inPane(page, pane, `console.log('back again'); 0`)

  await expect(rows(page)).toHaveCount(2)
  await expect(rows(page).getByTestId('console-message')).toHaveText(['dying words', 'back again'])
})

test('with preservation off, navigating moves the floor and changes nothing else', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)

  await page.getByTestId('console-preserve-log').click()
  await expect(page.getByTestId('console-preserve-log')).toHaveAttribute('aria-pressed', 'false')
  expect((await state()).console.preserveLog).toBe(false)

  await inPane(page, shop.panes[0].id, `console.warn('before the navigation'); 0`)
  await expect(rows(page)).toHaveCount(1)

  // From the window, as the address bar navigates: the allow-list binds automation only.
  const navigation = await page.evaluate(
    (url) => window.breakpoint.invoke('project.navigate', { url }),
    `${fixture.a}/?again`
  )
  expect(navigation.ok).toBe(true)

  await expect(rows(page)).toHaveCount(0)
  const log = await everything()
  const navigated = log.filter((entry) => entry.type === 'project.navigated').at(-1)!
  const after = await state()
  expect(after.console).toEqual({ floor: navigated.cursor, preserveLog: false })
  // The entry the window no longer shows is still the log's.
  expect(log.some((entry) => entry.type === 'console.message')).toBe(true)

  await attached(shop)
  await inPane(page, shop.panes[0].id, `console.log('after the navigation'); 0`)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).getByTestId('console-message')).toHaveText('after the navigation')
})
