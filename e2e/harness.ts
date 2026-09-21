import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import {
  encodeLine,
  LineBuffer,
  parseResponseLine,
  type RouteResponse
} from '../src/shared/protocol'
import { resolveSocketPath } from '../src/shared/paths'

export const REPO_ROOT = resolve(__dirname, '..')
export const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')
export const CLI_SHIM = join(REPO_ROOT, 'bin', 'breakpoint')

/**
 * A throwaway user data directory, which is a throwaway socket. Kept short: a unix
 * domain socket path cannot exceed about 104 bytes on macOS, and the repo's own path is
 * nowhere near short enough to nest one under.
 */
export class Sandbox {
  readonly userDataDir = mkdtempSync(join(tmpdir(), 'bp-'))
  readonly socketPath = resolveSocketPath({
    platform: process.platform,
    env: { BREAKPOINT_USER_DATA: this.userDataDir },
    homedir: this.userDataDir
  })

  /** Electron's launcher wants every value defined, so the inherited holes are dropped. */
  get env(): Record<string, string> {
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
    return {
      ...Object.fromEntries(inherited),
      BREAKPOINT_USER_DATA: this.userDataDir,
      BREAKPOINT_SOCKET: this.socketPath
    }
  }

  dispose(): void {
    // A just-quit app is still flushing its caches into here, so removal races it.
    rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

export interface LaunchedApp {
  app: ElectronApplication
  /** Everything the main process has written to stdout since launch. */
  output(): string
}

export async function launchApp(sandbox: Sandbox): Promise<LaunchedApp> {
  const app = await electron.launch({ args: [MAIN_ENTRY], env: sandbox.env })

  let output = ''
  app.process().stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  await waitFor(() => existsSync(sandbox.socketPath), 'the app to open its socket')
  await app.firstWindow()
  await waitFor(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      ),
    'the initial window to be shown'
  )
  return { app, output: () => output }
}

/**
 * Whether an app launched into this sandbox by something other than Playwright — the
 * CLI, or a second launch — is still alive. Electron writes the lock holder's pid into
 * `SingletonLock` as `<host>-<pid>`, which is the only handle a test has on it.
 */
export function isRunning(sandbox: Sandbox): boolean {
  const lock = join(sandbox.userDataDir, 'SingletonLock')
  let pid: number
  try {
    pid = Number(readlinkSync(lock).split('-').pop())
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Resolves when the app's process is gone, whatever quit it. */
export function waitForExit(launched: LaunchedApp, timeoutMs = 15_000): Promise<void> {
  const child = launched.app.process()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the app was still running ${timeoutMs}ms after it was told to quit`)),
      timeoutMs
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Quits through the app's own path rather than Playwright's `close`, which closes the
 * windows and waits for the process to exit — and on macOS closing the last window is
 * deliberately not a quit.
 */
export async function closeApp(launched: LaunchedApp): Promise<void> {
  const child = launched.app.process()
  const exited = waitForExit(launched)

  await launched.app.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await exited.catch(() => {
    child.kill('SIGKILL')
  })
  // Deliberately no `app.close()`: the process is gone, and Playwright's close waits on
  // a protocol connection that went with it.
}

export interface CliRun {
  code: number
  stdout: string
  stderr: string
}

/** Runs the repo-local shim, the same way a developer who symlinked it would. */
export function runCli(sandbox: Sandbox, args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(CLI_SHIM, args, { env: sandbox.env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Speaks the socket directly, for the envelope-level cases the CLI cannot express. */
export function sendRaw(socketPath: string, line: string): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const lines = new LineBuffer()
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(line.endsWith('\n') ? line : `${line}\n`))
    socket.on('data', (chunk: string) => {
      for (const received of lines.push(chunk)) {
        const parsed = parseResponseLine(received)
        socket.destroy()
        if (parsed.ok) resolve(parsed.response)
        else reject(new Error(parsed.error.message))
        return
      }
    })
    socket.on('error', reject)
  })
}

export function requestLine(route: string, params?: unknown): string {
  return encodeLine({ id: 'test', route, params })
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}
