import { resolve } from 'node:path'
import { looksLikePath } from '../shared/cli-surface'

/**
 * The repo a launch was pointed at, if any: `open -a Breakpoint .`, a Dock drop, or a
 * second copy started by hand. Pure, because the argv Electron hands over has its own
 * flags mixed in ahead of ours, and the rule for skipping them deserves a test with a
 * real argv in it.
 */

export interface LaunchMode {
  packaged: boolean
  /** Electron's default app is running our entry script: `electron index.js …`. */
  defaultApp: boolean
}

export function repoPathFromArguments(
  argv: readonly string[],
  mode: LaunchMode,
  workingDirectory: string
): string | undefined {
  const path = ownArguments(argv, mode).find((argument) => looksLikePath(argument))
  return path === undefined ? undefined : resolve(workingDirectory, path)
}

/**
 * Packaged, argv[0] is the app and the rest is ours. Under the default app, ours is
 * everything after the entry script, which is the first argument that is not a flag.
 * Anywhere else — a test runner importing the main module — none of argv is ours.
 */
function ownArguments(argv: readonly string[], { packaged, defaultApp }: LaunchMode): string[] {
  if (packaged) return argv.slice(1)
  if (!defaultApp) return []
  const entry = argv.findIndex((argument, index) => index > 0 && !argument.startsWith('-'))
  return entry === -1 ? [] : argv.slice(entry + 1)
}
