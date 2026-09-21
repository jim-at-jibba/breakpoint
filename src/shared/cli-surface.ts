import { resolve } from 'node:path'
import type { Project } from './project'
import type { RouteName, RouteParams } from './routes'
import type { StateSnapshot } from './state'

/**
 * Everything the `breakpoint` command accepts, declared once: the parser reads it, the
 * help text is printed from it, and the docs site's reference is checked against it. A
 * flag that is not in this file is a flag the CLI does not accept.
 *
 * Only what exists is declared. Commands from later phases are absent until they ship.
 */

export interface CliCommandSpec {
  /** What is typed. `<path>` is the one command with no name: a path stands in for it. */
  name: string
  route: RouteName
  summary: string
  /** How the route's payload reads on a terminal, when `--json` was not asked for. */
  render(data: unknown): string
}

/** The command a path invokes. `breakpoint .` and `breakpoint <path>` are both this. */
export const OPEN_COMMAND: CliCommandSpec = {
  name: '<path>',
  route: 'project.open',
  summary: 'Open the project for that repo, creating it the first time',
  render: (data) => renderSnapshot(data, 'Opened')
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  OPEN_COMMAND,
  {
    name: 'state',
    route: 'project.state',
    summary: 'Print the open project: name, repo, start URL and panes',
    render: (data) => renderSnapshot(data, 'Open')
  },
  {
    name: 'quit',
    route: 'app.quit',
    summary: 'Shut the app down cleanly, releasing the single-instance lock',
    render: () => 'Breakpoint is quitting.'
  }
]

function renderSnapshot(data: unknown, verb: string): string {
  const snapshot = data as Partial<StateSnapshot> | undefined
  const project = snapshot?.project as Project | null | undefined
  if (!project) return 'No project is open. Run `breakpoint .` in a repo.'
  const panes = project.panes.map(
    (pane) => `  ${pane.name.padEnd(10)}${pane.width}×${pane.height} @${pane.dpr}x`
  )
  return [
    `${verb} ${project.name} (${project.repoPath})`,
    `  ${project.startUrl}`,
    'Panes:',
    ...panes
  ].join('\n')
}

export interface CliOptions {
  json: boolean
  noLaunch: boolean
  verbose: boolean
}

export interface CliFlagSpec {
  name: string
  summary: string
  aliases?: readonly string[]
  /** The option this flag turns on, or `help`, which ends the run instead. */
  sets: keyof CliOptions | 'help'
}

export const CLI_FLAGS: readonly CliFlagSpec[] = [
  {
    name: '--json',
    summary: 'Print the route payload as JSON on stdout and nothing else',
    sets: 'json'
  },
  {
    name: '--no-launch',
    summary: 'Exit 3 rather than starting the app if it is not running',
    sets: 'noLaunch'
  },
  {
    name: '--verbose',
    summary: 'Print diagnostics on stderr, where they cannot pollute stdout',
    sets: 'verbose'
  },
  {
    name: '--help',
    aliases: ['-h'],
    summary: 'Print this help and exit 0',
    sets: 'help'
  }
]

export interface ExitCodeSpec {
  code: number
  name: string
  summary: string
  status: 'used' | 'reserved'
}

export const EXIT_CODES: readonly ExitCodeSpec[] = [
  { code: 0, name: 'success', summary: 'The command succeeded', status: 'used' },
  { code: 1, name: 'error', summary: 'An unexpected error', status: 'used' },
  { code: 2, name: 'usage', summary: 'The arguments could not be parsed', status: 'used' },
  {
    code: 3,
    name: 'not running',
    summary: 'The app is not running or is unreachable',
    status: 'used'
  },
  {
    code: 4,
    name: 'denied',
    summary: 'Reserved for the Phase 6 permission tiers',
    status: 'reserved'
  },
  { code: 5, name: 'paused', summary: 'Reserved for the Phase 6 stop control', status: 'reserved' }
]

export type ArgvParse =
  | {
      kind: 'command'
      command: CliCommandSpec
      options: CliOptions
      params: RouteParams<RouteName>
    }
  | { kind: 'help'; options: CliOptions }
  | { kind: 'error'; message: string; options: CliOptions }

const FLAGS_BY_NAME: ReadonlyMap<string, CliFlagSpec> = new Map(
  CLI_FLAGS.flatMap((flag) => [flag.name, ...(flag.aliases ?? [])].map((name) => [name, flag]))
)

/**
 * A positional argument is a path if it could only be one: `.`, `..`, or anything with a
 * separator in it. A bare word is always a command, so a typo stays a usage error rather
 * than quietly becoming a project called `stat`.
 */
export function looksLikePath(argument: string): boolean {
  return argument === '.' || argument === '..' || /[\\/]/.test(argument)
}

/**
 * `cwd` is where relative paths resolve. The app's own working directory is not the
 * terminal's, so the path has to be made absolute here, before it leaves the process
 * that knows.
 */
export function parseArgv(argv: readonly string[], cwd: string): ArgvParse {
  const options: CliOptions = { json: false, noLaunch: false, verbose: false }
  let positional: string | undefined
  let help = false
  let error: string | undefined

  for (const argument of argv) {
    if (argument.startsWith('-') && !looksLikePath(argument)) {
      const flag = FLAGS_BY_NAME.get(argument)
      if (!flag) {
        error ??= `unknown flag ${argument}`
        continue
      }
      if (flag.sets === 'help') help = true
      else options[flag.sets] = true
      continue
    }
    if (positional !== undefined) {
      error ??= `unexpected argument ${argument}`
      continue
    }
    positional = argument
  }

  if (error !== undefined) return { kind: 'error', message: error, options }
  if (help) return { kind: 'help', options }
  if (positional === undefined) {
    return { kind: 'error', message: 'no command or path given', options }
  }

  if (looksLikePath(positional)) {
    return {
      kind: 'command',
      command: OPEN_COMMAND,
      options,
      params: { path: resolve(cwd, positional) }
    }
  }

  const command = CLI_COMMANDS.find((candidate) => candidate.name === positional)
  if (!command) return { kind: 'error', message: `unknown command ${positional}`, options }

  return { kind: 'command', command, options, params: undefined }
}

/** Short and example-led, per PRD 7.3. */
export function helpText(): string {
  const pad = (text: string): string => text.padEnd(14)
  const flagLabel = (flag: CliFlagSpec): string => [flag.name, ...(flag.aliases ?? [])].join(', ')

  return [
    'breakpoint — a multi-viewport dev browser, driven from the terminal',
    '',
    'Usage: breakpoint <path> [flags]',
    '       breakpoint <command> [flags]',
    '',
    'Commands:',
    ...CLI_COMMANDS.map((command) => `  ${pad(command.name)}${command.summary}`),
    '',
    'Flags:',
    ...CLI_FLAGS.map((flag) => `  ${pad(flagLabel(flag))}${flag.summary}`),
    '',
    'Examples:',
    '  breakpoint .',
    '  breakpoint state --json | jq .project.panes',
    '  breakpoint quit',
    ''
  ].join('\n')
}
