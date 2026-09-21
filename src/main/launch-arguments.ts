import { resolve } from 'node:path'
import { looksLikePath } from '../shared/paths'

/**
 * The repo a command-line launch was pointed at, if any. Native macOS opens arrive
 * separately through `open-file`. The argv Electron hands over has its own
 * flags mixed in ahead of ours, and the rule for skipping them deserves a test with a
 * real argv in it.
 */

export interface LaunchMode {
  packaged: boolean
  /** Electron's default app is running our entry script: `electron index.js …`. */
  defaultApp: boolean
}

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
  const path = ownArguments(argv, mode).find(looksLikePath)
  return path === undefined ? undefined : resolve(workingDirectory, path)
}

/**
 * Packaged, argv[0] is the app and the rest is ours. Under the default app, ours is
 * everything after the entry script, which is the first argument that is not a flag.
 * Anywhere else — a test runner importing the main module — none of argv is ours.
 */
function ownArguments(argv: readonly string[], { packaged, defaultApp }: LaunchMode): string[] {
  if (!packaged && !defaultApp) return []
  const positional: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('-')) {
      if (PATH_SWITCHES.has(argument) && argv[index + 1]?.startsWith('-') === false) index += 1
      continue
    }
    positional.push(argument)
  }
  return packaged ? positional : positional.slice(1)
}
