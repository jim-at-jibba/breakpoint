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
import type { Navigation } from '../src/shared/routes'
import type { StateSnapshot } from '../src/shared/state'
import { startFixture, type Fixture, type RecordedRequest } from './fixture'
import { closeApp, launchApp, runCli, Sandbox, type CliRun, type LaunchedApp } from './harness'

/**
 * Navigation from the one address bar, and what the origin allow-list does and does not
 * bind ([ADR-0013]).
 *
 * The two fixture origins are the whole point here: `a` is what the project allows and
 * `b` is outside it, on a different host, so a navigation between them is genuinely
 * cross-site. Every assertion about where a pane ended up is read from the guest's own
 * `location`, not from what the app believes it asked for.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

function makeRepo(name: string, changes: Partial<StoredProject> = {}): StoredProject {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: StoredProject = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}/`,
    allowedOrigins: [new URL(fixture.a).origin],
    // Drawn at 100%: what navigation does is not the canvas's business.
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

async function logs(since = 0): Promise<Entry[]> {
  const run = await runCli(sandbox, ['logs', '--since', String(since), '--json'])
  expect(run.code).toBe(0)
  return [...(JSON.parse(run.stdout) as LogRead).entries]
}

/** Every pane loaded and attached, so a later navigation is the only thing moving. */
async function settled(project: StoredProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const [entries, snapshot] = await Promise.all([logs(), state()])
        return project.panes.every(
          (pane) =>
            entries.some((entry) => entry.type === 'pane.loaded' && entry.pane === pane.id) &&
            snapshot.panes[pane.id]?.attachment === 'attached'
        )
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

function inGuest<T>(app: LaunchedApp['app'], id: number, script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script),
    { id, script }
  ) as Promise<T>
}

/** Where each pane's page actually is, asked of the page. */
async function paneUrls(page: Page, project: StoredProject): Promise<string[]> {
  const app = launched!.app
  return Promise.all(
    project.panes.map(async (pane) =>
      inGuest<string>(app, await guestId(page, pane.id), 'location.href')
    )
  )
}

/** Polls until every pane's page is `url`, which is what "navigates every pane" means. */
async function expectPanesAt(page: Page, project: StoredProject, url: string): Promise<void> {
  await expect
    .poll(() => paneUrls(page, project), { timeout: 20_000 })
    .toEqual(project.panes.map(() => url))
}

function documents(origin: string): RecordedRequest[] {
  return fixture.requests().filter((request) => request.origin === origin)
}

function errorOf(run: CliRun): { code: string; message: string } {
  return (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error
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

test('the address bar points every pane at a URL, allowed or not', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const before = (await state()).cursor

  // `b` is deliberately outside the project's allowed origins. The developer typing is
  // never held to them: staging redirects outward and a tool that refuses is broken.
  await page.getByTestId('project-url').fill(`${fixture.b}/`)
  await page.getByTestId('project-url').press('Enter')

  await expectPanesAt(page, shop, `${fixture.b}/`)
  expect((await state()).project?.startUrl).toBe(`${fixture.b}/`)

  const entries = await logs(before)
  expect(entries.filter((entry) => entry.type === 'project.navigated')).toEqual([
    expect.objectContaining({ pane: null, url: `${fixture.b}/` })
  ])
  // Every pane's own load is on the same cursor, tagged with the pane.
  for (const pane of shop.panes) {
    expect(
      entries.some(
        (entry) =>
          entry.type === 'pane.loaded' && entry.pane === pane.id && entry.url.startsWith(fixture.b)
      )
    ).toBe(true)
  }
})

test('an older navigation result does not erase a newer address-bar draft', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const submitted = `${fixture.b}/submitted`
  const newer = `${fixture.b}/newer-draft`
  const address = page.getByTestId('project-url')

  await address.fill(submitted)
  await address.evaluate((element, next) => {
    const input = element as HTMLInputElement
    input.form?.requestSubmit()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, newer)

  await expectPanesAt(page, shop, submitted)
  await expect(address).toHaveValue(newer)
})

test('breakpoint open expands a bare port and reports where the panes went', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  // `b` is `http://localhost:<port>`, so its port is exactly what a bare port expands to.
  const port = new URL(fixture.b).port
  const shop = makeRepo('shop', {
    allowedOrigins: [new URL(fixture.a).origin, new URL(fixture.b).origin]
  })
  await open(shop)
  await settled(shop)

  const run = await runCli(sandbox, ['open', port, '--json'])
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(JSON.parse(run.stdout) as Navigation).toEqual({
    url: `http://localhost:${port}/`,
    panes: shop.panes.map((pane) => pane.id)
  })

  await expectPanesAt(page, shop, `${fixture.b}/`)
})

test('breakpoint open is refused outside the allowed origins, and no pane moves', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const before = (await state()).cursor

  const run = await runCli(sandbox, ['open', `${fixture.b}/`, '--json'])
  expect(run.code).toBe(1)
  expect(run.stdout).toBe('')
  expect(errorOf(run).code).toBe('ORIGIN_NOT_ALLOWED')

  expect(await paneUrls(page, shop)).toEqual(shop.panes.map(() => `${fixture.a}/`))
  expect((await state()).project?.startUrl).toBe(`${fixture.a}/`)
  expect(
    (await logs(before)).filter((entry) => entry.type === 'project.navigationRefused')
  ).toEqual([expect.objectContaining({ pane: null, url: `${fixture.b}/` })])

  // The same URL typed by the developer is not refused at all.
  await page.getByTestId('project-url').fill(`${fixture.b}/`)
  await page.getByTestId('project-url').press('Enter')
  await expectPanesAt(page, shop, `${fixture.b}/`)
})

test('a navigation started inside a pane leaves the project and the other panes alone', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const [mobile, tablet, desktop] = shop.panes

  // What clicking a link to an SSO domain does: the page moves itself, out of the
  // project's origins, and nothing stops it.
  await inGuest(app, await guestId(page, mobile.id), `location.href = ${JSON.stringify(fixture.b)}`)

  await expect
    .poll(() => paneUrls(page, shop), { timeout: 20_000 })
    .toEqual([`${fixture.b}/`, `${fixture.a}/`, `${fixture.a}/`])
  expect((await state()).project?.startUrl).toBe(`${fixture.a}/`)
  expect([tablet, desktop].map((pane) => pane.id)).toHaveLength(2)
})

test('a redirect out of an allowed origin is followed', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  // The navigation is to an origin the project allows; where the server sends it next is
  // the server's business.
  const run = await runCli(sandbox, [
    'open',
    `${fixture.a}/redirect?to=${encodeURIComponent(`${fixture.b}/`)}`,
    '--json'
  ])
  expect(run.code).toBe(0)

  await expectPanesAt(page, shop, `${fixture.b}/`)
})

test('allowed origins are edited in the window and survive a restart', async () => {
  launched = await launchApp(sandbox)
  let page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)

  await page.getByTestId('allowed-origins').click()
  // Typed the way an address is typed: no scheme, and a path on the end. The editor
  // expands it by the same rule the address bar uses and stores the origin it names.
  await page.getByTestId('add-origin-value').fill(`localhost:${new URL(fixture.b).port}/some/path`)
  await page.getByTestId('add-origin').click()
  await expect(page.getByTestId('allowed-origin')).toHaveCount(2)
  await expect(page.getByTestId('allowed-origin').last()).toHaveAttribute(
    'data-origin',
    new URL(fixture.b).origin
  )
  await page.keyboard.press('Escape')

  // The edit binds the next navigation from a terminal, which is the only thing it binds.
  const allowed = await runCli(sandbox, ['open', `${fixture.b}/`, '--json'])
  expect(allowed.code).toBe(0)
  await expectPanesAt(page, shop, `${fixture.b}/`)

  await closeApp(launched)
  launched = await launchApp(sandbox)
  page = await launched.app.firstWindow()
  await open(shop)

  const reopened = await state()
  expect(reopened.project?.allowedOrigins).toEqual([
    new URL(fixture.a).origin,
    new URL(fixture.b).origin
  ])
  // Where the panes were left is where the project reopens.
  expect(reopened.project?.startUrl).toBe(`${fixture.b}/`)
})

test('overlapping allowed-origin edits are applied in order', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop', {
    allowedOrigins: [new URL(fixture.a).origin, new URL(fixture.b).origin]
  })
  await open(shop)
  await page.getByTestId('allowed-origins').click()
  await expect(page.getByTestId('remove-origin')).toHaveCount(2)

  await page.getByTestId('remove-origin').evaluateAll((buttons) => {
    for (const button of buttons) (button as HTMLButtonElement).click()
  })

  await expect(page.getByTestId('allowed-origin')).toHaveCount(0)
  await expect.poll(async () => (await state()).project?.allowedOrigins).toEqual([])
})

test('emulation still holds after a navigation', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const shop = makeRepo('shop')
  await open(shop)
  await settled(shop)
  const before = documents(fixture.a).length

  const run = await runCli(sandbox, ['open', `${fixture.a}/?again`, '--json'])
  expect(run.code).toBe(0)
  await expectPanesAt(page, shop, `${fixture.a}/?again`)

  // The requests the navigation itself made, as a server doing device detection saw
  // them: two phones and a computer, exactly as before it.
  const requests = documents(fixture.a)
    .slice(before)
    .filter((request) => request.url === '/?again')
  expect(requests).toHaveLength(3)
  expect(
    requests.filter((request) => /Mobi/.test(String(request.headers['user-agent'])))
  ).toHaveLength(2)
  for (const request of requests) {
    expect(request.headers['user-agent']).not.toMatch(/Electron|breakpoint/i)
  }

  const snapshot = await state()
  for (const pane of shop.panes) {
    expect(Object.values(snapshot.panes[pane.id].emulation)).not.toContain('failed')
    expect(snapshot.panes[pane.id].degraded).toEqual([])
  }
})
