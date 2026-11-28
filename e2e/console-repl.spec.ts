import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { Evaluation } from '../src/shared/console'
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
 * The REPL (#79), probed in the real window: an expression evaluated in one pane or in all
 * of them, its answers drawn as rows tagged with their panes, top-level `await`, a throw
 * as an error answer, and history. `panes.evaluate` is a route, so the socket reaches it
 * too, though no command does yet ([ADR-0025]).
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

async function openAttached(project: StoredProject): Promise<void> {
  // Loaded, not only attached: a page still navigating answers that it was navigated.
  const run = await runCli(sandbox, ['.', '--wait', '--json'], project.repoPath)
  expect(run.code).toBe(0)
  await expect
    .poll(
      async () => {
        const state = await runCli(sandbox, ['state', '--json'])
        const { panes } = JSON.parse(state.stdout) as StateSnapshot
        return project.panes.every((pane) => panes[pane.id]?.attachment === 'attached')
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

function field(page: Page): Locator {
  return page.getByTestId('console-repl-input-field')
}

function results(page: Page): Locator {
  return page.getByTestId('console-repl-result')
}

async function evaluate(page: Page, expression: string): Promise<void> {
  await field(page).fill(expression)
  await field(page).press('Enter')
}

test('one pane answers as a row tagged with that pane', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await openAttached(shop)
  const [first] = shop.panes

  await page.locator(`[data-testid="console-repl-target"][data-pane="${first.id}"]`).click()
  await evaluate(page, 'innerWidth')

  await expect(results(page)).toHaveCount(1)
  await expect(results(page)).toHaveAttribute('data-pane', first.id)
  await expect(results(page)).toHaveAttribute('data-outcome', 'value')
  await expect(results(page).getByTestId('console-message')).toHaveText(String(first.width))
  await expect(results(page).getByTestId('console-pane-badge')).toHaveAttribute(
    'data-pane',
    first.id
  )

  // Clear clears what was evaluated with everything else.
  await page.getByTestId('console-clear').click()
  await expect(page.getByTestId('console-repl-input')).toHaveCount(0)
  await expect(results(page)).toHaveCount(0)

  // Evaluating a value does not advance the log, so another Clear has the same floor.
  await evaluate(page, '1 + 1')
  await expect(results(page)).toHaveCount(1)
  await expect(results(page).getByTestId('console-message')).toHaveText('2')
  await page.getByTestId('console-clear').click()
  await expect(page.getByTestId('console-repl-input')).toHaveCount(0)
  await expect(results(page)).toHaveCount(0)
})

test('every pane answers, one row each, and a throw is an answer rather than a crash', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await openAttached(shop)

  await evaluate(page, 'await new Promise((resolve) => setTimeout(() => resolve(innerWidth), 50))')

  await expect(results(page)).toHaveCount(shop.panes.length)
  for (const [index, pane] of shop.panes.entries()) {
    const row = results(page).nth(index)
    await expect(row).toHaveAttribute('data-pane', pane.id)
    await expect(row.getByTestId('console-message')).toHaveText(String(pane.width))
  }

  await evaluate(page, 'null.width')
  await expect(
    page.locator('[data-testid="console-repl-result"][data-outcome="thrown"]')
  ).toHaveCount(shop.panes.length)
  await expect(
    page.locator('[data-testid="console-repl-result"][data-outcome="thrown"]').first()
  ).toContainText('Uncaught TypeError')

  // Still answering after it.
  await evaluate(page, '1 + 1')
  await expect(
    page.locator('[data-testid="console-repl-result"][data-outcome="value"]').last()
  ).toHaveText(/2$/)
})

test('Up and Down step through history', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await openAttached(shop)

  await evaluate(page, '1')
  await evaluate(page, '2')
  await field(page).fill('half')

  await field(page).press('ArrowUp')
  await expect(field(page)).toHaveValue('2')
  await field(page).press('ArrowUp')
  await expect(field(page)).toHaveValue('1')
  await field(page).press('ArrowDown')
  await expect(field(page)).toHaveValue('2')
  await field(page).press('ArrowDown')
  await expect(field(page)).toHaveValue('half')
})

test('panes.evaluate is a route the socket reaches, with no command for it', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  await openAttached(shop)

  const response = await sendRaw(
    sandbox.socketPath,
    requestLine('panes.evaluate', { expression: 'innerWidth' })
  )

  expect(response.ok).toBe(true)
  const { results: answered } = (response as { data: { results: Evaluation[] } }).data
  expect(answered).toEqual(
    shop.panes.map((pane) => ({ pane: pane.id, outcome: 'value', text: String(pane.width) }))
  )
  const run = await runCli(sandbox, ['eval', 'innerWidth'])
  expect(run.code).toBe(2)
})
