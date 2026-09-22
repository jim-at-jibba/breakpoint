import { resolve } from 'node:path'
import { looksLikePath } from '../shared/paths'

/**
 * What a command-line launch asked for: the repo it was pointed at, and whether it was
 * started in the background. Native macOS opens arrive separately through `open-file`.
 * The argv Electron hands over has its own flags mixed in ahead of ours, and the rule
 * for skipping them deserves a test with a real argv in it.
 */

export interface LaunchMode {
  packaged: boolean
  /** Electron's default app is running our entry script: `electron index.js …`. */
  defaultApp: boolean
}

/**
 * What the CLI passes the app it starts for `--background`. Spelled the same as the flag
 * the developer types, so a `ps` line reads as what was asked for, but declared here
 * rather than shared with it: this is the app's own launch protocol, and a collision with
 * a Chromium switch is a reason to rename one of them without renaming the other. The two
 * spellings are pinned together by a test.
 */
export const BACKGROUND_SWITCH = '--background'

const PATH_SWITCHES: ReadonlySet<string> = new Set([
  '--log-file',
  '--log-net-log',
  '--user-data-dir',
  '--disk-cache-dir'
])

export function repoPathFromArguments(
  argv: readonly string[],
  mode: LaunchMode,
  workingDirectory: string
): string | undefined {
  const path = ownArguments(argv, mode).positional.find(looksLikePath)
  return path === undefined ? undefined : resolve(workingDirectory, path)
}

/**
 * Whether this launch was asked not to take focus. Only the CLI passes it, and only
 * when it started the app itself; a developer opening Breakpoint from the Dock is
 * activating it by definition.
 */
export function backgroundFromArguments(argv: readonly string[], mode: LaunchMode): boolean {
  return ownArguments(argv, mode).switches.includes(BACKGROUND_SWITCH)
}

interface OwnArguments {
  switches: string[]
  positional: string[]
}

/**
 * Packaged, argv[0] is the app and the rest is ours. Under the default app, ours is
 * everything after the entry script, which is the first argument that is not a flag —
 * so a switch Electron put in ahead of it is Electron's and never ours. Anywhere else —
 * a test runner importing the main module — none of argv is ours.
 */
function ownArguments(argv: readonly string[], { packaged, defaultApp }: LaunchMode): OwnArguments {
  if (!packaged && !defaultApp) return { switches: [], positional: [] }
  const switches: string[] = []
  const positional: string[] = []
  /** Packaged there is no entry script to step over, so everything from argv[1] is ours. */
  let pastEntry = packaged

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('-')) {
      if (PATH_SWITCHES.has(argument) && argv[index + 1]?.startsWith('-') === false) index += 1
      else if (pastEntry) switches.push(argument)
      continue
    }
    if (!pastEntry) {
      pastEntry = true
      continue
    }
    positional.push(argument)
  }
  return { switches, positional }
}
