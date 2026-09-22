import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  type Project
} from '../src/shared/project'
import type { StateSnapshot } from '../src/shared/state'
import { APP_THEME_BACKGROUND, type AppTheme, type ThemePreference } from '../src/shared/theme'
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
 * The app theme, probed from outside: the file it leaves behind, the class the window
 * puts on its own document, and the colour the window itself is painted.
 *
 * The one thing that cannot be driven from here is the developer changing the OS
 * appearance while the app runs — nothing in a test can set macOS to light. That is what
 * `ThemeHost` is a seam for, and the unit tests drive it there. What this file can show
 * is the rest: that the preference is kept, that it survives a restart, that it reaches
 * the window in the snapshot and nowhere else, and that no pane moves when it changes.
 */

let sandbox: Sandbox
let launched: LaunchedApp | undefined
let repos: string
let fixture: Fixture

function settingsFile(): string {
  return join(sandbox.userDataDir, 'settings.json')
}

function storedSettings(): unknown {
  return existsSync(settingsFile())
    ? (JSON.parse(readFileSync(settingsFile(), 'utf8')) as unknown)
    : undefined
}

/**
 * A repo with a project already written for it, pointed at the fixture and drawn at
 * 100%: these cases need panes that actually load a page, because what the page makes of
 * the app's theme is the thing under test.
 */
function makeRepo(name: string): Project {
  const path = join(repos, name)
  mkdirSync(path, { recursive: true })
  const project: Project = {
    ...createProject(realpathSync.native(path)),
    startUrl: `${fixture.a}/`,
    zoom: 100
  }
  const projects = join(sandbox.userDataDir, 'projects')
  mkdirSync(projects, { recursive: true })
  writeFileSync(
    join(projects, projectFileName(project.repoPath)),
    `${JSON.stringify(writeProjectFile(project), null, 2)}\n`
  )
  return project
}

function guestId(page: Page, pane: string): Promise<number> {
  return page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId()
    )
}

/** What the page inside a pane makes of the colour scheme it is being served. */
function guestPrefersDark(app: LaunchedApp['app'], id: number): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, id) =>
      webContents
        .fromId(id)!
        .executeJavaScript(
          `matchMedia('(prefers-color-scheme: dark)').matches`
        ) as Promise<boolean>,
    id
  )
}

/** Every pane loaded, attached, measured and emulating what it declares. */
async function settled(project: Project): Promise<void> {
  await expect
    .poll(async () => {
      const panes = (await snapshot()).panes
      return project.panes.every((pane) => {
        const status = panes[pane.id]
        return (
          status?.attachment === 'attached' &&
          status.geometry !== 'unchecked' &&
          Object.values(status.emulation).every((capability) => capability !== 'pending')
        )
      })
    })
    .toBe(true)
}

async function snapshot(): Promise<StateSnapshot> {
  const run = await runCli(sandbox, ['state', '--json'])
  expect(run.stderr).toBe('')
  return JSON.parse(run.stdout) as StateSnapshot
}

async function openProject(project: Project): Promise<void> {
  const run = await runCli(sandbox, ['.'], project.repoPath)
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
}

async function setTheme(preference: ThemePreference): Promise<void> {
  const response = await sendRaw(sandbox.socketPath, requestLine('app.setTheme', { preference }))
  expect(response).toMatchObject({ ok: true })
}

/** The class the token layers in `index.css` are keyed on. */
function themeClass(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.className)
}

/**
 * The colour the window is painted, which is what shows before its renderer has.
 * Lower-cased: Electron answers in upper-case hex and the token is written in lower.
 */
async function windowColour(app: LaunchedApp): Promise<string> {
  const colour = await app.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor()
  )
  return colour.toLowerCase()
}

test.beforeEach(async () => {
  sandbox = new Sandbox()
  launched = undefined
  repos = mkdtempSync(join(tmpdir(), 'bp-repos-'))
  fixture = await startFixture()
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
  await fixture.close()
  rmSync(repos, { recursive: true, force: true })
})

test('a first launch follows the desktop and stores nothing', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  const state = await snapshot()

  expect(state.theme.preference).toBe('system')
  expect(['light', 'dark']).toContain(state.theme.active)
  // Nothing was chosen, so there is nothing to keep.
  expect(storedSettings()).toBeUndefined()
  await expect.poll(() => themeClass(page)).toBe(state.theme.active)
  expect(await windowColour(launched)).toBe(APP_THEME_BACKGROUND[state.theme.active])
})

test('an override takes the chrome away from the desktop, and the window with it', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const started = await snapshot()
  const away: AppTheme = started.theme.active === 'dark' ? 'light' : 'dark'

  await setTheme(away)

  const state = await snapshot()
  expect(state.theme).toEqual({ preference: away, active: away })
  await expect.poll(() => themeClass(page)).toBe(away)
  // The window's own colour moves with it, so the next window it opens is not the
  // colour the last theme was.
  expect(await windowColour(launched)).toBe(APP_THEME_BACKGROUND[away])
  expect(storedSettings()).toEqual({ version: 1, theme: away })
})

test('an override survives a restart, and the window never starts the wrong colour', async () => {
  launched = await launchApp(sandbox)
  const started = await snapshot()
  const away: AppTheme = started.theme.active === 'dark' ? 'light' : 'dark'
  await setTheme(away)
  await closeApp(launched)

  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  // The window is painted from the stored preference when it is constructed, which is
  // before its renderer has painted anything: there is no white to flash.
  expect(await windowColour(launched)).toBe(APP_THEME_BACKGROUND[away])
  const state = await snapshot()
  expect(state.theme).toEqual({ preference: away, active: away })
  await expect.poll(() => themeClass(page)).toBe(away)
})

test('going back to system hands the chrome to the desktop again', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const started = await snapshot()
  await setTheme(started.theme.active === 'dark' ? 'light' : 'dark')

  await setTheme('system')

  const state = await snapshot()
  expect(state.theme).toEqual({ preference: 'system', active: started.theme.active })
  await expect.poll(() => themeClass(page)).toBe(started.theme.active)
  expect(storedSettings()).toEqual({ version: 1, theme: 'system' })
})

test('the theme reaches the window in the snapshot, as a patch and not a channel of its own', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()
  const started = await snapshot()
  const away: AppTheme = started.theme.active === 'dark' ? 'light' : 'dark'

  await setTheme(away)

  // The window's own projection, which is fed by `project.state` and patches over the
  // one patch channel. If the theme had arrived any other way it would not be in here.
  await expect.poll(() => page.getByTestId('app-theme').getAttribute('data-active')).toBe(away)
  const state = await snapshot()
  expect(state.revision).toBeGreaterThan(started.revision)
})

/**
 * The case the whole separation exists for, and the one a snapshot comparison cannot
 * see: a pane whose colour scheme is `system` emulates no override, so its page follows
 * Chromium's native theme. Overriding the app theme through `nativeTheme.themeSource`
 * would put the app's chrome inside that page — measured, and warned about in
 * `shared/emulation.ts`. This probes the page itself, not what the snapshot says about it.
 */
test('the app theme does not reach the page inside a pane emulating no scheme', async () => {
  launched = await launchApp(sandbox)
  const { app } = launched
  const page = await app.firstWindow()
  const shop = makeRepo('shop')
  await openProject(shop)
  await settled(shop)
  const [mobile] = shop.panes
  expect(mobile.colorScheme).toBe('system')
  const id = await guestId(page, mobile.id)
  const desktopDark = await guestPrefersDark(app, id)

  // The app taken the other way from the desktop, which is the whole point of an override.
  const away: AppTheme = desktopDark ? 'light' : 'dark'
  await setTheme(away)
  await expect.poll(async () => (await snapshot()).theme.active).toBe(away)

  // The page has not moved with it.
  expect(await guestPrefersDark(app, id)).toBe(desktopDark)
})

test('the app theme and a pane colour scheme leave each other alone', async () => {
  launched = await launchApp(sandbox)
  const shop = makeRepo('shop')
  await openProject(shop)
  const opened = await snapshot()
  const [pane] = opened.project?.panes ?? []
  expect(pane.colorScheme).toBe('system')

  // A pane emulating dark, and then the app theme moved underneath it.
  await sendRaw(
    sandbox.socketPath,
    requestLine('panes.setEmulation', { pane: pane.id, colorScheme: 'dark' })
  )
  const emulated = await snapshot()
  expect(emulated.theme).toEqual(opened.theme)

  await setTheme(opened.theme.active === 'dark' ? 'light' : 'dark')

  const themed = await snapshot()
  expect(themed.project?.panes.map((each) => each.colorScheme)).toEqual(
    emulated.project?.panes.map((each) => each.colorScheme)
  )
})

test('settings this build will not read leave the chrome on the desktop, and the file alone', async () => {
  // A file from a newer Breakpoint. Reading past it and saving over it would turn one
  // unknown version into a silent reset of everything the developer had set.
  const written = '{ "version": 99, "theme": "light" }\n'
  mkdirSync(sandbox.userDataDir, { recursive: true })
  writeFileSync(settingsFile(), written)

  launched = await launchApp(sandbox)

  const state = await snapshot()
  expect(state.theme.preference).toBe('system')
  const refused = await sendRaw(
    sandbox.socketPath,
    requestLine('app.setTheme', { preference: 'dark' })
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'SETTINGS_UNREADABLE' } })
  expect(readFileSync(settingsFile(), 'utf8')).toBe(written)
})
