import { resolve } from 'node:path'
import { focusedPaneOf } from './canvas'
import { describeCertificateTrustReason, type CertificateState } from './certificates'
import { isCursorPosition, type Entry, type LogRead } from './event-log'
import { formatDpr } from './pane-header'
import { describeDegradation, type LoadState } from './panes'
import { looksLikePath } from './paths'
import type { Project, Zoom } from './project'
import type { Navigation, RouteName, RouteParams } from './routes'
import type { StateSnapshot } from './state'

/**
 * Everything the `breakpoint` command accepts, declared once: the parser reads it, the
 * help text is printed from it, and the Docs' CLI reference is checked against it. A
 * flag that is not in this file is a flag the CLI does not accept.
 *
 * Only what exists is declared. Commands from later phases are absent until they ship.
 */

interface CliCommandInput {
  positional: string
  /** The token after the command name, for the commands that declare one. */
  argument: string | undefined
  cwd: string
  values: ReadonlyMap<string, readonly string[]>
}

interface CommandSpec<N extends RouteName> {
  /** What is typed. `<path>` is the one command with no name: a path stands in for it. */
  name: string
  route: N
  summary: string
  /**
   * The one positional this command takes after its name. Required where it is declared
   * and refused where it is not, so `breakpoint quit now` stays a usage error.
   */
  argument?: CliArgumentSpec
  /**
   * The value-carrying flags this command takes, which are the route's params by
   * another spelling. Given to a command that does not declare it, such a flag is a
   * usage error rather than a param the app has to refuse.
   */
  flags?: readonly CliValueFlagSpec[]
  /**
   * Whether `--wait` is a flag of this command, and what it prints once the panes are
   * ready. `snapshot` replaces the route's payload with the snapshot the wait ended
   * on, because that payload *is* a snapshot and the one taken before the panes loaded
   * would be a lie. `payload` keeps what the route answered. Absent, `--wait` is a usage
   * error: `quit` and `logs` have no panes to wait for.
   */
  waits?: 'snapshot' | 'payload'
  /**
   * Whether this command brings the window forward when it succeeds, which `--background`
   * is the way to skip. Only opening a project does: the developer ran it to look at
   * something, and everything else is a question rather than an act.
   */
  activates?: true
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

export interface CliArgumentSpec {
  /** How it reads in the help text: `open <url>`. */
  placeholder: string
}

/** Written once, because `parseArgv` and the command's own parser can both reach it. */
function needsArgument(name: string, argument: CliArgumentSpec): string {
  return `${name} needs ${argument.placeholder}`
}

const URL_ARGUMENT: CliArgumentSpec = { placeholder: '<url>' }

const SINCE_FLAG: CliValueFlagSpec = {
  name: '--since',
  placeholder: '<cursor>'
}

/**
 * The command a path invokes. `breakpoint .` and `breakpoint <path>` are both this.
 * Named for the path and not for opening, because `open` is a different command that
 * opens a URL rather than a project.
 */
export const PATH_COMMAND: CliCommandSpec<'project.open'> = {
  name: '<path>',
  route: 'project.open',
  summary: 'Open the project for that repo, creating it the first time',
  waits: 'snapshot',
  activates: true,
  parseParams: ({
    cwd,
    positional
  }: CliCommandInput): ParsedValue<RouteParams<'project.open'>> => ({
    ok: true,
    value: { path: resolve(cwd, positional) }
  }),
  render: (data) => renderSnapshot(data, 'Opened')
}

/**
 * Navigation, as an agent reaches it: one URL, every pane. What was typed is sent as
 * typed — a bare port expands in the route, so the terminal and the address bar cannot
 * disagree about what `3000` means.
 */
const NAVIGATE_COMMAND: CliCommandSpec<'project.navigate'> = {
  name: 'open',
  route: 'project.navigate',
  summary: 'Point every pane at a URL, or at a port on this machine',
  argument: URL_ARGUMENT,
  waits: 'payload',
  // A missing argument is already a usage error by the time this runs; whitespace is
  // the case only the command itself can see.
  parseParams: ({ argument }: CliCommandInput): ParsedValue<RouteParams<'project.navigate'>> =>
    argument === undefined || argument.trim() === ''
      ? { ok: false, message: needsArgument('open', URL_ARGUMENT) }
      : { ok: true, value: { url: argument } },
  render: renderNavigation
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  PATH_COMMAND,
  NAVIGATE_COMMAND,
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
    summary: 'Print the open project: name, repo, the URL its panes are on, and the panes',
    waits: 'snapshot',
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

function renderNavigation(data: unknown): string {
  const navigation = data as Partial<Navigation> | undefined
  const panes = navigation?.panes?.length ?? 0
  return `Pointed ${panes} ${panes === 1 ? 'pane' : 'panes'} at ${navigation?.url ?? 'nothing'}`
}

function renderSnapshot(data: unknown, verb: string): string {
  const snapshot = data as Partial<StateSnapshot> | undefined
  const project = snapshot?.project as Project | null | undefined
  // The cursor is printed either way: a failed open leaves nothing open, and that is
  // precisely when the log is the only thing with something to say.
  const cursor = `Cursor ${snapshot?.cursor ?? 0}`
  // Certificate trust is the app's and not a project's, so it is said with nothing open
  // too — and said at all only when there is something to say, because a line reading
  // "0 trusted, 0 waiting" is noise on every run that never met one.
  const certificates = describeCertificates(snapshot?.certificates)
  if (!project) {
    return ['No project is open. Run `breakpoint .` in a repo.', ...certificates, cursor].join('\n')
  }
  const panes = project.panes.map((pane) => {
    const status = snapshot?.panes?.[pane.id]
    let line = `  ${pane.name.padEnd(10)}${pane.width}×${pane.height} ${formatDpr(pane.dpr)}`
    // Where the pane's page got to, which is half of what `--wait` waits for. A pane
    // that has arrived says nothing, so the ones that have not are what stands out.
    line += LOAD_DESCRIPTIONS[status?.load ?? 'pending']
    // The same two things the pane's header says, for the surface that has no header.
    if (status?.errors) line += `  errors: ${status.errors}`
    const degraded = status?.degraded ?? []
    if (degraded.length === 0) return line
    return `${line}  degraded: ${degraded.map(describeDegradation).join('; ')}`
  })
  return [
    `${verb} ${project.name} (${project.repoPath})`,
    `  ${project.startUrl}`,
    `  ${describeLayout(project)}, zoom ${describeZoom(project.zoom)}`,
    'Panes:',
    ...panes,
    ...certificates,
    // The position to hand to `logs --since`, which is the point of printing it.
    cursor
  ].join('\n')
}

/** What a pane's line says about its page. A pane that has arrived says nothing. */
const LOAD_DESCRIPTIONS: Readonly<Record<LoadState, string>> = {
  pending: '  loading',
  loaded: '',
  failed: '  load failed'
}

/**
 * What certificate trust holds, as one line, or nothing at all. A pane held by a waiting
 * certificate is not loading and is not failing either, and a terminal that says nothing
 * about it leaves the only surface an agent has with no way to find out.
 */
function describeCertificates(certificates: CertificateState | undefined): string[] {
  const trusted = certificates?.trusted.length ?? 0
  const waiting = certificates?.waiting.length ?? 0
  if (trusted === 0 && waiting === 0) return []
  return [`Certificates: ${trusted} trusted, ${waiting} waiting`]
}

/** `Fit` where the project says Fit: what Fit draws to is the window's, and not stored. */
function describeZoom(zoom: Zoom): string {
  return zoom === 'fit' ? 'Fit' : `${zoom}%`
}

function describeLayout(project: Project): string {
  if (project.layout === 'horizontal') return 'Horizontal'
  const focused = focusedPaneOf(project.panes, project.focusedPane)
  return `Focus on ${focused?.name ?? 'no pane'}`
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
    case 'pane.added':
      return `added at ${entry.width}×${entry.height}${entry.preset ? ` from the ${entry.preset} preset` : ''}`
    case 'pane.removed':
      return 'removed from the project'
    case 'pane.resized':
      return `resized to ${entry.width}×${entry.height}`
    case 'project.layoutChanged':
      return `layout ${entry.layout}${entry.focusedPane ? `, focused pane ${entry.focusedPane}` : ''}`
    case 'project.zoomChanged':
      return `zoom ${describeZoom(entry.zoom)}`
    case 'project.navigated':
      return `every pane pointed at ${entry.url}`
    case 'project.navigationRefused':
      return `refused: ${entry.url} is outside the project's allowed origins`
    case 'project.originsChanged':
      return `allowed origins ${entry.origins.length === 0 ? 'none' : entry.origins.join(', ')}`
    case 'certificate.trusted':
      return `trusted ${entry.host} ${entry.fingerprint} (${describeCertificateTrustReason(entry.reason)}, ${entry.error})`
    case 'certificate.prompted':
      return `waiting on ${entry.host} ${entry.fingerprint}: ${entry.error} loading ${entry.url}`
    case 'certificate.refused':
      return `refused ${entry.host} ${entry.fingerprint}: ${entry.error}`
    case 'certificate.forgotten':
      return `forgot the decision for ${entry.host} ${entry.fingerprint}`
    case 'pane.created':
      return `created, loading ${entry.url}`
    case 'pane.attached':
      return `attached (attempt ${entry.attempt})`
    case 'pane.attachFailed':
      return `attachment failed (attempt ${entry.attempt}, ${entry.retrying ? 'retrying after load' : 'not retrying'}): ${entry.message}`
    case 'pane.loaded':
      return `loaded ${entry.url}`
    case 'pane.loadFailed':
      return `could not load ${entry.url}: ${entry.code} ${entry.message}`
    case 'pane.geometryMismatch':
      return `degraded: ${entry.message}`
    case 'pane.geometryMatched':
      return 'drawn at its declared size again'
    case 'pane.emulationChanged':
      return `emulation set: ${Object.entries(entry.changes)
        .map(([name, value]) => `${name} ${String(value)}`)
        .join(', ')}`
    case 'pane.emulationFailed':
      return `degraded: ${entry.capability} not emulated: ${entry.message}`
    case 'pane.emulationRecovered':
      return `${entry.capability} emulated again`
    case 'pane.destroyed':
      return 'destroyed'
  }
}

export interface CliOptions {
  json: boolean
  noLaunch: boolean
  verbose: boolean
  wait: boolean
  background: boolean
}

/**
 * How long `--wait` gives the panes before it reports `TIMEOUT`. Generous enough for a
 * cold dev server to compile the page, and finite because an agent blocked forever is
 * worse than one told the app never got there.
 */
export const WAIT_TIMEOUT_MS = 30_000

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
    name: '--wait',
    summary: `Block until every pane has loaded and is drawn at its declared size, for up to ${WAIT_TIMEOUT_MS / 1000}s`,
    sets: 'wait'
  },
  {
    name: '--background',
    summary: 'Start or hand off without bringing the window forward',
    sets: 'background'
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
  const options: CliOptions = {
    json: false,
    noLaunch: false,
    verbose: false,
    wait: false,
    background: false
  }
  const given: GivenValueFlag[] = []
  /** The command name, then its one argument. Anything further is a usage error. */
  const positionals: string[] = []
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
    if (positionals.length === 2) {
      error ??= `unexpected argument ${argument}`
      continue
    }
    positionals.push(argument)
  }

  if (error !== undefined) return { kind: 'error', message: error, options }
  if (help) return { kind: 'help', options }
  const [positional, argument] = positionals
  if (positional === undefined) {
    return { kind: 'error', message: 'no command or path given', options }
  }

  const command = looksLikePath(positional)
    ? PATH_COMMAND
    : CLI_COMMANDS.find((candidate) => candidate.name === positional)
  if (!command) return { kind: 'error', message: `unknown command ${positional}`, options }
  if (!command.argument && argument !== undefined) {
    return { kind: 'error', message: `unexpected argument ${argument}`, options }
  }
  if (command.argument && argument === undefined) {
    return { kind: 'error', message: needsArgument(command.name, command.argument), options }
  }

  if (options.wait && command.waits === undefined) {
    return { kind: 'error', message: `--wait is not a flag of ${command.name}`, options }
  }

  const values = readValueFlags(command, given)
  if (!values.ok) return { kind: 'error', message: values.message, options }
  const params = command.parseParams({ cwd, positional, argument, values: values.value })
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
      ...(command.argument ? [command.argument.placeholder] : []),
      ...(command.flags ?? []).map((flag) => `[${flag.name} ${flag.placeholder}]`),
      ...(command.waits ? ['[--wait]'] : [])
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
    '  breakpoint . --wait --json',
    '  breakpoint open 3000',
    '  breakpoint open https://staging.example.com/cart --json',
    '  breakpoint state --json | jq .project.panes',
    '  breakpoint logs --since 12 --json',
    '  breakpoint quit',
    ''
  ].join('\n')
}
