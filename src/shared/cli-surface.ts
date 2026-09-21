import type { RouteName } from './routes'

/**
 * Everything the `breakpoint` command accepts, declared once: the parser reads it, the
 * help text is printed from it, and the docs site's reference is checked against it. A
 * flag that is not in this file is a flag the CLI does not accept.
 *
 * Only what exists is declared. Commands from later phases are absent until they ship.
 */

export interface CliCommandSpec {
  name: string
  route: RouteName
  summary: string
  /** How the route's payload reads on a terminal, when `--json` was not asked for. */
  render(data: unknown): string
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: 'quit',
    route: 'app.quit',
    summary: 'Shut the app down cleanly, releasing the single-instance lock',
    render: () => 'Breakpoint is quitting.'
  }
]

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
  | { kind: 'command'; command: CliCommandSpec; options: CliOptions }
  | { kind: 'help'; options: CliOptions }
  | { kind: 'error'; message: string }

const FLAGS_BY_NAME: ReadonlyMap<string, CliFlagSpec> = new Map(
  CLI_FLAGS.flatMap((flag) => [flag.name, ...(flag.aliases ?? [])].map((name) => [name, flag]))
)

export function parseArgv(argv: readonly string[]): ArgvParse {
  const options: CliOptions = { json: false, noLaunch: false, verbose: false }
  let commandName: string | undefined
  let help = false

  for (const argument of argv) {
    if (argument.startsWith('-')) {
      const flag = FLAGS_BY_NAME.get(argument)
      if (!flag) return { kind: 'error', message: `unknown flag ${argument}` }
      if (flag.sets === 'help') help = true
      else options[flag.sets] = true
      continue
    }
    if (commandName !== undefined) {
      return { kind: 'error', message: `unexpected argument ${argument}` }
    }
    commandName = argument
  }

  if (help) return { kind: 'help', options }
  if (commandName === undefined) return { kind: 'error', message: 'no command given' }

  const command = CLI_COMMANDS.find((candidate) => candidate.name === commandName)
  if (!command) return { kind: 'error', message: `unknown command ${commandName}` }

  return { kind: 'command', command, options }
}

/** Short and example-led, per PRD 7.3. */
export function helpText(): string {
  const pad = (text: string): string => text.padEnd(14)
  const flagLabel = (flag: CliFlagSpec): string => [flag.name, ...(flag.aliases ?? [])].join(', ')

  return [
    'breakpoint — a multi-viewport dev browser, driven from the terminal',
    '',
    'Usage: breakpoint <command> [flags]',
    '',
    'Commands:',
    ...CLI_COMMANDS.map((command) => `  ${pad(command.name)}${command.summary}`),
    '',
    'Flags:',
    ...CLI_FLAGS.map((flag) => `  ${pad(flagLabel(flag))}${flag.summary}`),
    '',
    'Examples:',
    '  breakpoint quit',
    '  breakpoint quit --json | jq .quitting',
    ''
  ].join('\n')
}
