import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

/**
 * Where the app's user data lives, and where the socket sits inside it. The main process
 * and the CLI are separate processes that have to agree on this without talking first,
 * so both compute it here rather than each knowing the rule.
 *
 * Not imported by the renderer — it reaches routes over IPC and never sees the socket.
 */

/**
 * A command-line argument is a path if it could only be one: `.`, `..`, or anything with a
 * separator in it. A bare word is never a path, so a typo stays a usage error rather than
 * quietly becoming a project called `stat`.
 */
export function looksLikePath(argument: string): boolean {
  return argument === '.' || argument === '..' || /[\\/]/.test(argument)
}

/** Matches `productName` in electron-builder.yml, and is set on `app` so dev agrees with a build. */
export const APP_NAME = 'Breakpoint'

export const SOCKET_FILENAME = 'breakpoint.sock'

export interface PathEnvironment {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  homedir: string
}

export function currentPathEnvironment(homedir: string): PathEnvironment {
  return { platform: process.platform, env: process.env, homedir }
}

/** Electron's own `userData` rule, plus a `BREAKPOINT_USER_DATA` override for tests. */
export function resolveUserDataDir({ platform, env, homedir }: PathEnvironment): string {
  const override = env.BREAKPOINT_USER_DATA
  if (override) return override

  if (platform === 'win32') {
    const appData = env.APPDATA ?? win32.join(homedir, 'AppData', 'Roaming')
    return win32.join(appData, APP_NAME)
  }
  if (platform === 'darwin') {
    return posix.join(homedir, 'Library', 'Application Support', APP_NAME)
  }
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(homedir, '.config'), APP_NAME)
}

/**
 * A unix domain socket in the user data directory, or a named pipe on Windows. Pipes are
 * a flat global namespace with no directory to scope them, so the user data directory is
 * hashed into the name to keep two installs — or two test runs — apart.
 */
export function resolveSocketPath(environment: PathEnvironment): string {
  const override = environment.env.BREAKPOINT_SOCKET
  if (override) return override

  const userDataDir = resolveUserDataDir(environment)
  if (environment.platform === 'win32') {
    const key = createHash('sha256').update(userDataDir).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\breakpoint-${key}`
  }
  return posix.join(userDataDir, SOCKET_FILENAME)
}
