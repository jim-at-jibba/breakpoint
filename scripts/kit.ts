// Proof helpers. Launches a built Breakpoint (branch or main) from an arbitrary checkout
// root, drives it, and captures the composited window (guests included) as PNG.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const BRANCH = '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console'
export const ROOTS = {
  branch: BRANCH,
  main: process.env.BP_MAIN_ROOT ?? ''
}
export const PROOF = '/home/jamesgbest/.local/state/loop2/jim-at-jibba-breakpoint/49/proof'

// Shared module code is loaded from the branch checkout (project file shape is unchanged
// between main and the branch for what these scripts write).
export { createProject, projectFileName, writeProjectFile } from '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console/src/shared/project'
export { startFixture, FLOOD, FLOOD_PATH } from '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console/e2e/fixture'
export { bundledPageFor, BUNDLED_SOURCES } from '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console/e2e/bundle'
export { sendRaw, requestLine } from '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console/e2e/harness'
import { resolveSocketPath } from '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console/src/shared/paths'
import { projectFileName, writeProjectFile } from '/home/jamesgbest/Projects/breakpoint/feature-49-spec-phase-2b-the-console/src/shared/project'

export class Box {
  readonly userDataDir = mkdtempSync(join(tmpdir(), 'bpp-'))
  readonly socketPath = resolveSocketPath({
    platform: process.platform,
    env: { BREAKPOINT_USER_DATA: this.userDataDir },
    homedir: this.userDataDir
  })
  get env(): Record<string, string> {
    const inherited = Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined
    )
    return {
      ...Object.fromEntries(inherited),
      BREAKPOINT_USER_DATA: this.userDataDir,
      BREAKPOINT_SOCKET: this.socketPath
    }
  }
  store(project: any): void {
    const dir = join(this.userDataDir, 'projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, projectFileName(project.repoPath)), JSON.stringify(writeProjectFile(project)))
  }
}

export function makeRepo(name: string, withSources?: string): string {
  const base = mkdtempSync(join(tmpdir(), 'bpp-repo-'))
  const path = join(base, name)
  mkdirSync(path)
  if (withSources) cpSync(withSources, join(path, 'src'), { recursive: true })
  return realpathSync.native(path)
}

async function until(cond: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export interface App {
  app: ElectronApplication
  page: Page
  root: string
  box: Box
}

export async function launch(root: string, box: Box): Promise<App> {
  const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js')], env: box.env })
  await until(() => existsSync(box.socketPath), 'socket')
  const page = await app.firstWindow()
  await until(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible())),
    'window shown'
  )
  return { app, page, root, box }
}

export async function close(a: App): Promise<void> {
  await a.app.close().catch(() => {})
}

export function cli(a: { root: string; box: Box }, args: string[], cwd?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(join(a.root, 'bin', 'breakpoint'), args, { env: a.box.env, cwd: cwd ?? a.root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Transcript of a CLI run, as a shell would show it. */
export async function cliTranscript(a: App, args: string[], cwd?: string, jq?: (v: any) => any): Promise<string> {
  const run = await cli(a, args, cwd)
  let out = run.stdout
  if (jq) {
    try {
      out = JSON.stringify(jq(JSON.parse(run.stdout)), null, 2) + '\n'
    } catch {
      /* keep raw */
    }
  }
  return `$ breakpoint ${args.join(' ')}\n${out}${run.stderr}[exit ${run.code}]\n`
}

export async function shot(a: App, name: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 250))
  const b64 = await a.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => w.isVisible() && !w.webContents.getURL().startsWith('devtools:')
    )!
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  const file = join(PROOF, name)
  writeFileSync(file, Buffer.from(b64, 'base64'))
  return file
}

export async function frame(a: App): Promise<Buffer> {
  const b64 = await a.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => w.isVisible() && !w.webContents.getURL().startsWith('devtools:')
    )!
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  return Buffer.from(b64, 'base64')
}

export async function inPane(a: App, pane: string, script: string): Promise<any> {
  const id = await a.page
    .locator(`webview[data-pane="${pane}"]`)
    .evaluate((el) => (el as unknown as { getWebContentsId(): number }).getWebContentsId())
  return a.app.evaluate(
    ({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script),
    { id, script }
  )
}

export function save(name: string, text: string): void {
  writeFileSync(join(PROOF, name), text)
}

export async function state(a: App): Promise<any> {
  return JSON.parse((await cli(a, ['state', '--json'])).stdout)
}

export async function attachedAll(a: App, panes: { id: string }[]): Promise<void> {
  await until(async () => {
    const s = await state(a)
    return panes.every((p) => s.panes?.[p.id]?.attachment === 'attached')
  }, 'panes attached', 40_000)
}

export { until }
