import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Entry, LogRead } from '../src/shared/event-log'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type StoredProject
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
 * Real DevTools on a pane (#80), probed in the real window. The header's button opens it
 * on that pane and no other, and it sits beside Breakpoint's attachment rather than in
 * place of it: with DevTools open, and after it closes, the pane's console still reaches
 * the log and its error count still moves ([ADR-0003]).
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

async function state(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as StateSnapshot
}

async function openAttached(project: StoredProject): Promise<void> {
  const run = await runCli(sandbox, ['.', '--wait', '--json'], project.repoPath)
  expect(run.code).toBe(0)
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

function guestId(page: Page, pane: string): Promise<number> {
  return page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
}

/** Which of these guests have DevTools open. */
function devToolsOpen(app: LaunchedApp['app'], ids: number[]): Promise<boolean[]> {
  return app.evaluate(
    ({ webContents }, ids) => ids.map((id) => webContents.fromId(id)?.isDevToolsOpened() ?? false),
    ids
  )
}

async function said(pane: string, text: string): Promise<boolean> {
  const run = await runCli(sandbox, ['logs', '--json'])
  const { entries } = JSON.parse(run.stdout) as LogRead
  return entries.some(
    (entry: Entry) =>
      entry.pane === pane &&
      entry.type === 'console.message' &&
      JSON.stringify(entry).includes(text)
  )
}

/** Logs an error in the pane, and waits for both the entry and the count it moves. */
async function logError(pane: string, text: string): Promise<void> {
  const before = (await state()).panes[pane]?.errors ?? 0
  const response = await sendRaw(
    sandbox.socketPath,
    requestLine('panes.evaluate', { expression: `console.error(${JSON.stringify(text)})`, pane })
  )
  expect(response.ok).toBe(true)
  await expect.poll(() => said(pane, text), { timeout: 10_000 }).toBe(true)
  await expect
    .poll(async () => (await state()).panes[pane]?.errors, { timeout: 10_000 })
    .toBe(before + 1)
}

test('the button opens DevTools on its own pane, and Breakpoint keeps hearing it open and closed', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await openAttached(shop)
  // The widest pane: at Fit, a narrow one's header has no room for its actions.
  const target = shop.panes.length - 1
  const pane = shop.panes[target]
  const ids = await Promise.all(shop.panes.map((pane) => guestId(page, pane.id)))

  await page.locator(`[data-testid="pane-devtools"][data-pane="${pane.id}"]`).click()

  await expect
    .poll(() => devToolsOpen(launched!.app, ids))
    .toEqual(shop.panes.map((_, index) => index === target))
  await expect(page.getByTestId('pane-action-error')).toHaveCount(0)

  // Open: still attached, still heard, still counted.
  await logError(pane.id, 'heard with DevTools open')
  expect((await state()).panes[pane.id]?.attachment).toBe('attached')

  // Closed: nothing Breakpoint observes has changed.
  await launched.app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)!.closeDevTools(),
    ids[target]
  )
  await expect.poll(() => devToolsOpen(launched!.app, ids)).toEqual(shop.panes.map(() => false))
  await logError(pane.id, 'heard after DevTools closed')
  const { panes } = await state()
  expect(panes[pane.id]?.attachment).toBe('attached')
  expect(panes[pane.id]?.degraded).toEqual([])
})

test('panes.openDevTools is a route the socket reaches', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await openAttached(shop)
  const [, second] = shop.panes

  const response = await sendRaw(
    sandbox.socketPath,
    requestLine('panes.openDevTools', { pane: second.id })
  )

  expect(response).toMatchObject({ ok: true, data: { opened: true } })
  const id = await guestId(page, second.id)
  await expect.poll(async () => (await devToolsOpen(launched!.app, [id]))[0]).toBe(true)

  const missing = await sendRaw(
    sandbox.socketPath,
    requestLine('panes.openDevTools', { pane: 'nope' })
  )
  expect(missing).toMatchObject({ ok: false, error: { code: 'PANE_NOT_FOUND' } })
})
