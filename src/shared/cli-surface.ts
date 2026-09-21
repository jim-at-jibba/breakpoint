import type { RouteName } from './routes'

/**
 * Everything the `breakpoint` command accepts, declared once. The CLI parses from this,
 * the help text is printed from it, and the docs site's reference is checked against it
 * (#21), so the binary and the documentation cannot drift.
 *
 * Only what exists is declared here. Commands from later phases are absent until they ship.
 */

export interface CliCommandSpec {
  name: string
  route: RouteName
  summary: string
  /**
   * `if-needed` connects to the socket first and starts the app only if that fails;
   * `--no-launch` turns it into a failure instead. `never` would refuse outright.
   */
  launch: 'if-needed' | 'never'
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: 'quit',
    route: 'app.quit',
    summary: 'Shut the app down cleanly, releasing the single-instance lock',
    launch: 'if-needed'
  }
]

export interface CliFlagSpec {
  name: string
  summary: string
}

export const CLI_FLAGS: readonly CliFlagSpec[] = [
  { name: '--json', summary: 'Print the route payload as JSON on stdout and nothing else' },
  { name: '--no-launch', summary: 'Exit 3 rather than starting the app if it is not running' },
  { name: '--verbose', summary: 'Print diagnostics on stderr, where they cannot pollute stdout' },
  { name: '--help', summary: 'Print this help and exit 0' }
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

export interface CliOptions {
  json: boolean
  noLaunch: boolean
  verbose: boolean
}

export type ArgvParse =
  | { kind: 'command'; command: CliCommandSpec; options: CliOptions }
  | { kind: 'help'; options: CliOptions }
  | { kind: 'error'; message: string }

const FLAG_NAMES: ReadonlySet<string> = new Set(CLI_FLAGS.map((flag) => flag.name))

export function parseArgv(argv: readonly string[]): ArgvParse {
  const options: CliOptions = { json: false, noLaunch: false, verbose: false }
  let commandName: string | undefined
  let help = false

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument.startsWith('-')) {
      if (!FLAG_NAMES.has(argument)) return { kind: 'error', message: `unknown flag ${argument}` }
      if (argument === '--json') options.json = true
      if (argument === '--no-launch') options.noLaunch = true
      if (argument === '--verbose') options.verbose = true
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
  return [
    'breakpoint — a multi-viewport dev browser, driven from the terminal',
    '',
    'Usage: breakpoint <command> [flags]',
    '',
    'Commands:',
    ...CLI_COMMANDS.map((command) => `  ${pad(command.name)}${command.summary}`),
    '',
    'Flags:',
    ...CLI_FLAGS.map((flag) => `  ${pad(flag.name)}${flag.summary}`),
    '',
    'Examples:',
    '  breakpoint quit',
    '  breakpoint quit --json | jq .quitting',
    ''
  ].join('\n')
}
