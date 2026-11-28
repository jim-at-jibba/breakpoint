import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CONSOLE_ROW_HEIGHT } from '../src/shared/console-rows'
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
 * The Console tab's rows, probed in the real window (#74): one per console entry the log
 * retains, each badged in its pane's header colour, all one height, and a list that
 * follows the newest entry until the developer scrolls up, then holds its place.
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

function scroller(page: Page): Locator {
  return page.getByTestId('console-scroller')
}

function scrollMetrics(
  page: Page
): Promise<{ top: number; height: number; client: number; first: number }> {
  return scroller(page).evaluate((element, rowHeight) => {
    const cursors = [...element.querySelectorAll<HTMLElement>('[data-testid="console-row"]')]
      .filter((row) => row.offsetTop + rowHeight > element.scrollTop)
      .map((row) => Number(row.dataset.cursor))
    return {
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
      first: Math.min(...cursors)
    }
  }, CONSOLE_ROW_HEIGHT)
}

test('every console entry is a fixed-height row, badged in its pane’s header colour', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)

  for (const pane of shop.panes) {
    await inPane(page, pane.id, `console.log('hello from ${pane.id}'); 0`)
  }
  const long = 'a long line '.repeat(200)
  await inPane(page, shop.panes[0].id, `console.warn(${JSON.stringify(`${long}\nsecond`)}); 0`)

  await expect.poll(async () => (await consoleEntries()).length).toBe(shop.panes.length + 1)
  await expect(rows(page)).toHaveCount(shop.panes.length + 1)

  for (const pane of shop.panes) {
    const row = rows(page).filter({ hasText: `hello from ${pane.id}` })
    await expect(row).toHaveCount(1)
    const badge = await row
      .getByTestId('console-pane-badge')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    const tab = await page
      .locator(`[data-testid="pane"][data-pane="${pane.id}"]`)
      .getByTestId('pane-tab')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(badge).toBe(tab)
  }

  const heights = await rows(page).evaluateAll((all) =>
    all.map((row) => row.getBoundingClientRect().height)
  )
  expect(new Set(heights)).toEqual(new Set([CONSOLE_ROW_HEIGHT]))
  const message = rows(page).filter({ hasText: 'a long line' }).getByTestId('console-message')
  const box = await message.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scroll: element.scrollWidth,
    client: element.clientWidth
  }))
  expect(box.height).toBeLessThan(CONSOLE_ROW_HEIGHT)
  expect(box.scroll).toBeGreaterThan(box.client)
})

test('the list follows new entries at the bottom, and holds its place once scrolled up', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)
  const [mobile] = shop.panes

  await inPane(page, mobile.id, `for (let n = 0; n < 300; n += 1) console.log('first ' + n); 0`)
  await expect(rows(page).filter({ hasText: 'first 299' })).toHaveCount(1)
  await expect
    .poll(async () => {
      const { top, height, client } = await scrollMetrics(page)
      return height - client - top
    })
    .toBeLessThan(CONSOLE_ROW_HEIGHT)

  await scroller(page).evaluate((element, rowHeight) => {
    element.scrollTop = rowHeight * 40
  }, CONSOLE_ROW_HEIGHT)
  await expect.poll(async () => (await scrollMetrics(page)).top).toBe(CONSOLE_ROW_HEIGHT * 40)
  const held = await scrollMetrics(page)

  await inPane(page, mobile.id, `for (let n = 0; n < 300; n += 1) console.log('second ' + n); 0`)
  await expect
    .poll(async () => (await scrollMetrics(page)).height)
    .toBeGreaterThanOrEqual(held.height + 300 * CONSOLE_ROW_HEIGHT)

  const after = await scrollMetrics(page)
  expect(after.top).toBe(held.top)
  expect(after.first).toBe(held.first)

  // Back at the bottom, it follows again.
  await scroller(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await inPane(page, mobile.id, `console.log('newest'); 0`)
  await expect(rows(page).filter({ hasText: 'newest' })).toBeVisible()
})

test('the same message from several panes is one row carrying each of their badges', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)
  const [one, two, three] = shop.panes
  const say = `console.error('the same error'); 0`

  await inPane(page, one.id, say)
  await inPane(page, two.id, say)
  await inPane(page, one.id, `console.log('something else'); 0`)
  await expect.poll(async () => (await consoleEntries()).length).toBe(3)

  // Asserted on the panes a row carries, never on how many rows there are: a view that
  // dropped entries and one that collapsed them draw the same number.
  const row = rows(page).filter({ hasText: 'the same error' })
  await expect(row).toHaveAttribute('data-panes', `${one.id} ${two.id}`)

  // A matching entry arriving later joins the row rather than starting another.
  await inPane(page, three.id, say)
  await expect(row).toHaveAttribute('data-panes', `${one.id} ${two.id} ${three.id}`)
  await expect(row.getByTestId('console-pane-badge')).toHaveCount(2)
  await expect(row.getByTestId('console-more-badge')).toHaveText('+1')

  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  const entries = page.getByTestId('console-entry')
  await expect(entries).toHaveCount(3)
  expect(
    await entries
      .getByTestId('console-pane-badge')
      .evaluateAll((all) => all.map((badge) => (badge as HTMLElement).dataset.pane))
  ).toEqual([one.id, two.id, three.id])
  for (const entry of await entries.all()) {
    await expect(entry).toContainText(/\d\d:\d\d:\d\d\.\d{3}/)
    await expect(entry.getByTestId('console-message')).toHaveText('the same error')
  }

  await row.click()
  await expect(entries).toHaveCount(0)
})

test('filters by pane, level and text narrow the view alone and together, and clear', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await attached(shop)
  const [one, two, three] = shop.panes

  for (const pane of shop.panes) await inPane(page, pane.id, `console.error('broken at width'); 0`)
  await inPane(page, two.id, `console.warn('slow image'); 0`)
  await inPane(page, three.id, `console.log('ready'); 0`)
  await expect.poll(async () => (await consoleEntries()).length).toBe(5)

  const broken = rows(page).filter({ hasText: 'broken at width' })
  await expect(broken).toHaveAttribute('data-panes', `${one.id} ${two.id} ${three.id}`)

  const pane = (id: string): Locator =>
    page.locator(`[data-testid="console-filter-pane"][data-pane="${id}"]`)
  const level = (name: string): Locator =>
    page.locator(`[data-testid="console-filter-level"][data-level="${name}"]`)

  // Pane alone: the collapsed row carries only the badges still in view.
  await pane(one.id).click()
  await expect(pane(one.id)).toHaveAttribute('aria-pressed', 'false')
  await expect(broken).toHaveAttribute('data-panes', `${two.id} ${three.id}`)
  await expect(broken.getByTestId('console-more-badge')).toHaveCount(0)
  await expect(rows(page).filter({ hasText: 'slow image' })).toHaveCount(1)

  // Level combined with it.
  await level('warn').click()
  await level('log').click()
  await expect(rows(page).filter({ hasText: 'slow image' })).toHaveCount(0)
  await expect(rows(page).filter({ hasText: 'ready' })).toHaveCount(0)
  await expect(broken).toHaveCount(1)

  // Text combined with both, then on its own.
  await page.getByTestId('console-filter-text').fill('nothing says this')
  await expect(rows(page)).toHaveCount(0)
  await page.getByTestId('console-filter-clear').click()
  await expect(page.getByTestId('console-filter-text')).toHaveValue('')
  await page.getByTestId('console-filter-text').fill('SLOW')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page)).toHaveAttribute('data-panes', two.id)

  // Clearing brings back every retained entry; the log never moved.
  await page.getByTestId('console-filter-clear').click()
  await expect(broken).toHaveAttribute('data-panes', `${one.id} ${two.id} ${three.id}`)
  await expect(rows(page).filter({ hasText: 'slow image' })).toHaveCount(1)
  await expect(rows(page).filter({ hasText: 'ready' })).toHaveCount(1)
  expect(await consoleEntries()).toHaveLength(5)
})
