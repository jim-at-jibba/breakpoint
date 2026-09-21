import { resolve } from 'node:path'
import { isCursorPosition, type Entry, type LogRead } from './event-log'
import { looksLikePath } from './paths'
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

interface CliCommandInput {
  positional: string
  cwd: string
  values: ReadonlyMap<string, readonly string[]>
}

interface CommandSpec<N extends RouteName> {
  /** What is typed. `<path>` is the one command with no name: a path stands in for it. */
  name: string
  route: N
  summary: string
  /**
   * The value-carrying flags this command takes, which are the route's params by
   * another spelling. Given to a command that does not declare it, such a flag is a
   * usage error rather than a param the app has to refuse.
   */
  flags?: readonly CliValueFlagSpec[]
  parseParams(input: CliCommandInput): ParsedValue<RouteParams<N>>
  /** How the route's payload reads on a terminal, when `--json` was not asked for. */
  render(data: unknown): string
}

export type CliCommandSpec<N extends RouteName = RouteName> = {
  [R in N]: CommandSpec<R>
}[N]

export type ParsedValue<T> = { ok: true; value: T } | { ok: false; message: string }

export interface CliValueFlagSpec {
  name: string
  /** How the value reads in the help text: `--since <cursor>`. */
  placeholder: string
}

const SINCE_FLAG: CliValueFlagSpec = {
  name: '--since',
  placeholder: '<cursor>'
}

/** The command a path invokes. `breakpoint .` and `breakpoint <path>` are both this. */
export const OPEN_COMMAND: CliCommandSpec<'project.open'> = {
  name: '<path>',
  route: 'project.open',
  summary: 'Open the project for that repo, creating it the first time',
  parseParams: ({
    cwd,
    positional
  }: CliCommandInput): ParsedValue<RouteParams<'project.open'>> => ({
    ok: true,
    value: { path: resolve(cwd, positional) }
  }),
  render: (data) => renderSnapshot(data, 'Opened')
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  OPEN_COMMAND,
  {
    name: 'logs',
    route: 'log.read',
    summary: 'Print what the event log holds after a cursor position',
    flags: [SINCE_FLAG],
    parseParams: parseLogParams,
    render: renderLog
  },
  {
    name: 'state',
    route: 'project.state',
    summary: 'Print the open project: name, repo, start URL and panes',
    parseParams: (): ParsedValue<RouteParams<'project.state'>> => ({ ok: true, value: undefined }),
    render: (data) => renderSnapshot(data, 'Open')
  },
  {
    name: 'quit',
    route: 'app.quit',
    summary: 'Shut the app down cleanly, releasing the single-instance lock',
    parseParams: (): ParsedValue<RouteParams<'app.quit'>> => ({ ok: true, value: undefined }),
    render: () => 'Breakpoint is quitting.'
  }
]

function parseLogParams({ values }: CliCommandInput): ParsedValue<RouteParams<'log.read'>> {
  const params: RouteParams<'log.read'> = {}
  for (const raw of values.get(SINCE_FLAG.name) ?? []) {
    const since = raw.trim() === '' ? Number.NaN : Number(raw)
    if (!isCursorPosition(since)) {
      return { ok: false, message: `--since takes a cursor position, not ${raw}` }
    }
    params.since = since
  }
  return { ok: true, value: params }
}

function renderSnapshot(data: unknown, verb: string): string {
  const snapshot = data as Partial<StateSnapshot> | undefined
  const project = snapshot?.project as Project | null | undefined
  // The cursor is printed either way: a failed open leaves nothing open, and that is
  // precisely when the log is the only thing with something to say.
  const cursor = `Cursor ${snapshot?.cursor ?? 0}`
  if (!project) {
    return ['No project is open. Run `breakpoint .` in a repo.', cursor].join('\n')
  }
  const panes = project.panes.map(
    (pane) => `  ${pane.name.padEnd(10)}${pane.width}×${pane.height} @${pane.dpr}x`
  )
  return [
    `${verb} ${project.name} (${project.repoPath})`,
    `  ${project.startUrl}`,
    'Panes:',
    ...panes,
    // The position to hand to `logs --since`, which is the point of printing it.
    cursor
  ].join('\n')
}

function renderLog(data: unknown): string {
  const read = data as Partial<LogRead> | undefined
  const entries = read?.entries ?? []
  const lines: string[] = []

  if (read?.droppedBefore !== undefined) {
    lines.push(`Entries before cursor ${read.droppedBefore} were evicted and are gone.`)
  }
  for (const entry of entries) {
    const marker = entry.truncated ? ` [truncated: ${entry.truncated.join(', ')}]` : ''
    lines.push(`${entry.cursor}  ${entry.pane ?? 'app'}  ${describeEntry(entry)}${marker}`)
  }
  if (entries.length === 0) lines.push(`Nothing after cursor ${read?.cursor ?? 0}.`)

  return lines.join('\n')
}

function describeEntry(entry: Entry): string {
  switch (entry.type) {
    case 'project.openFailed':
      return `could not open ${entry.path}: ${entry.code}: ${entry.message}`
  }
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
 * Every value flag any command declares, which is what lets the parser know a flag
 * takes the token after it before it knows which command was asked for — flags are
 * allowed on either side of the command name.
 */
const VALUE_FLAGS_BY_NAME: ReadonlyMap<string, CliValueFlagSpec> = new Map(
  CLI_COMMANDS.flatMap((command) => (command.flags ?? []).map((flag) => [flag.name, flag]))
)

interface GivenValueFlag {
  flag: CliValueFlagSpec
  raw: string
}

/**
 * `cwd` is where relative paths resolve. The app's own working directory is not the
 * terminal's, so the path has to be made absolute here, before it leaves the process
 * that knows.
 */
export function parseArgv(argv: readonly string[], cwd: string): ArgvParse {
  const options: CliOptions = { json: false, noLaunch: false, verbose: false }
  const given: GivenValueFlag[] = []
  let positional: string | undefined
  let help = false
  let error: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('-')) {
      const separator = argument.indexOf('=')
      const name = separator === -1 ? argument : argument.slice(0, separator)
      const valueFlag = VALUE_FLAGS_BY_NAME.get(name)
      if (valueFlag) {
        if (separator !== -1) {
          given.push({ flag: valueFlag, raw: argument.slice(separator + 1) })
          continue
        }
        const next = argv[index + 1]
        const nextName = next?.split('=', 1)[0]
        if (
          next === undefined ||
          (nextName !== undefined &&
            (FLAGS_BY_NAME.has(nextName) || VALUE_FLAGS_BY_NAME.has(nextName)))
        ) {
          error ??= `${valueFlag.name} needs ${valueFlag.placeholder}`
          continue
        }
        index += 1
        given.push({ flag: valueFlag, raw: next })
        continue
      }

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

  const command = looksLikePath(positional)
    ? OPEN_COMMAND
    : CLI_COMMANDS.find((candidate) => candidate.name === positional)
  if (!command) return { kind: 'error', message: `unknown command ${positional}`, options }

  const values = readValueFlags(command, given)
  if (!values.ok) return { kind: 'error', message: values.message, options }
  const params = command.parseParams({ cwd, positional, values: values.value })
  if (!params.ok) return { kind: 'error', message: params.message, options }

  return { kind: 'command', command, options, params: params.value }
}

function readValueFlags(
  command: CliCommandSpec,
  given: readonly GivenValueFlag[]
): ParsedValue<ReadonlyMap<string, readonly string[]>> {
  const values = new Map<string, string[]>()
  for (const { flag, raw } of given) {
    if (!command.flags?.includes(flag)) {
      return { ok: false, message: `${flag.name} is not a flag of ${command.name}` }
    }
    const previous = values.get(flag.name) ?? []
    previous.push(raw)
    values.set(flag.name, previous)
  }
  return { ok: true, value: values }
}

/** Short and example-led, per PRD 7.3. */
export function helpText(): string {
  const flagLabel = (flag: CliFlagSpec): string => [flag.name, ...(flag.aliases ?? [])].join(', ')
  const commandLabel = (command: CliCommandSpec): string =>
    [
      command.name,
      ...(command.flags ?? []).map((flag) => `[${flag.name} ${flag.placeholder}]`)
    ].join(' ')

  const labels = [...CLI_COMMANDS.map(commandLabel), ...CLI_FLAGS.map(flagLabel)]
  const width = Math.max(...labels.map((label) => label.length)) + 2
  const pad = (text: string): string => text.padEnd(width)

  return [
    'breakpoint — a multi-viewport dev browser, driven from the terminal',
    '',
    'Usage: breakpoint <path> [flags]',
    '       breakpoint <command> [flags]',
    '',
    'Commands:',
    ...CLI_COMMANDS.map((command) => `  ${pad(commandLabel(command))}${command.summary}`),
    '',
    'Flags:',
    ...CLI_FLAGS.map((flag) => `  ${pad(flagLabel(flag))}${flag.summary}`),
    '',
    'Examples:',
    '  breakpoint .',
    '  breakpoint state --json | jq .project.panes',
    '  breakpoint logs --since 12 --json',
    '  breakpoint quit',
    ''
  ].join('\n')
}
