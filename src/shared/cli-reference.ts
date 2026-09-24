import { CLI_COMMANDS, CLI_FLAGS, EXIT_CODES, parseArgv } from './cli-surface'
import { looksLikePath } from './paths'
import { ERROR_CODES } from './protocol'
import { ROUTE_NAMES } from './routes'

/**
 * The Docs' CLI reference, checked against what the code declares (#21). The check
 * runs both ways: a command the CLI accepts and the reference leaves out fails, and so
 * does a flag the reference describes and the CLI has dropped — a page that describes a
 * flag which no longer exists is worse than one that is merely incomplete.
 *
 * The examples are checked too, on every page and not only the reference (#29): a prose
 * example of a flag the CLI does not have is the command a reader types first, and the
 * reference table being right does nothing for it.
 *
 * Pure, so it runs in the unit seam: the caller reads the markdown, this reads nothing.
 * Imported only by tests.
 */

/** Everything the reference has to account for, by the name a reader would search for. */
export interface DeclaredSurface {
  /** `<path>` for the command a path stands in for, and the typed name for the rest. */
  commands: readonly string[]
  /** Every spelling a flag is accepted by, aliases and value flags included. */
  flags: readonly string[]
  exitCodes: readonly number[]
  errorCodes: readonly string[]
  routes: readonly string[]
}

export const DECLARED_SURFACE: DeclaredSurface = {
  commands: CLI_COMMANDS.map((command) => command.name),
  flags: [
    ...CLI_FLAGS.flatMap((flag) => [flag.name, ...(flag.aliases ?? [])]),
    ...new Set(CLI_COMMANDS.flatMap((command) => (command.flags ?? []).map((flag) => flag.name)))
  ],
  exitCodes: EXIT_CODES.map((exit) => exit.code),
  errorCodes: ERROR_CODES,
  routes: ROUTE_NAMES
}

/** What each part of the surface is called in a finding, and where the reference keeps it. */
const PARTS: readonly {
  key: keyof DeclaredSurface
  noun: string
  section: string
  read: (section: string) => string[]
}[] = [
  { key: 'commands', noun: 'command', section: 'Commands', read: readCommandHeadings },
  { key: 'flags', noun: 'flag', section: 'Flags', read: readFlagTable },
  { key: 'exitCodes', noun: 'exit code', section: 'Exit codes', read: readFirstColumn },
  { key: 'errorCodes', noun: 'error code', section: 'Error codes', read: readFirstColumn },
  { key: 'routes', noun: 'route', section: 'Routes', read: readFirstColumn }
]

/** One line per disagreement, and none when the reference and the code agree. */
export function referenceDrift(
  markdown: string,
  declared: DeclaredSurface = DECLARED_SURFACE
): string[] {
  const sections = splitSections(markdown)
  const findings: string[] = []
  for (const part of PARTS) {
    const section = sections.get(part.section)
    if (section === undefined) {
      findings.push(`the docs reference has no \`## ${part.section}\` section`)
      continue
    }
    const documented = new Set(part.read(section))
    const names = new Set(declared[part.key].map(String))
    for (const name of names) {
      if (!documented.has(name)) {
        findings.push(
          `${part.noun} \`${name}\` is declared but the docs reference does not document it`
        )
      }
    }
    for (const name of documented) {
      if (!names.has(name)) {
        findings.push(`${part.noun} \`${name}\` is documented but the CLI no longer declares it`)
      }
    }
  }
  return findings
}

/** Each `## ` section's body, keyed by its heading. Deeper headings stay in the body. */
function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  let heading: string | undefined
  let body: string[] = []
  for (const line of withoutFences(markdown).split('\n')) {
    const match = /^## (.+?)\s*$/.exec(line)
    if (match) {
      if (heading !== undefined) sections.set(heading, body.join('\n'))
      heading = match[1]
      body = []
    } else {
      body.push(line)
    }
  }
  if (heading !== undefined) sections.set(heading, body.join('\n'))
  return sections
}

/** Each line, and whether it is inside a fence. A fence's own ``` lines are neither. */
function fencing(markdown: string): { line: string; fenced: boolean | undefined }[] {
  let open = false
  return markdown.split('\n').map((line) => {
    if (!/^\s*```/.test(line)) return { line, fenced: open }
    open = !open
    return { line, fenced: undefined }
  })
}

/** Blank lines where the fences were, so a `## ` or a `|` inside an example is not read. */
function withoutFences(markdown: string): string {
  return fencing(markdown)
    .map(({ line, fenced }) => (fenced === false ? line : ''))
    .join('\n')
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1])
}

/**
 * The `### ` headings, each naming one command as it is typed: `breakpoint open <url>` is
 * `open`. A path in a heading is the path command, so `` `breakpoint .` `` is `<path>`.
 */
function readCommandHeadings(section: string): string[] {
  return section
    .split('\n')
    .filter((line) => /^### /.test(line))
    .flatMap(codeSpans)
    .map((span) => span.split(/\s+/))
    .filter(([program]) => program === 'breakpoint')
    .map(([, name = '']) => (looksLikePath(name) ? '<path>' : name))
}

/** The body rows of every table in the section, as their cells. */
function tableRows(section: string): string[][] {
  const rows = section
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
    )
  // A header row is always followed by its `| --- |` separator.
  return rows.filter((cells, index) => !isSeparator(cells) && !isSeparator(rows[index + 1]))
}

function isSeparator(row: string[] | undefined): boolean {
  return row !== undefined && row.every((cell) => /^:?-+:?$/.test(cell))
}

function readFirstColumn(section: string): string[] {
  return tableRows(section).flatMap(([first = '']) => codeSpans(first))
}

/** `--help`, `-h` is two spellings; `--since <cursor>` is the flag `--since`. */
function readFlagTable(section: string): string[] {
  return readFirstColumn(section).map((span) => span.split(/\s+/)[0])
}

/**
 * Every fenced line that runs `breakpoint` and that the CLI would refuse as typed, one
 * finding per line. Only the command itself is parsed: a trailing `# comment` and
 * anything after a pipe are the shell's, not the CLI's.
 */
export function brokenExamples(markdown: string): string[] {
  const findings: string[] = []
  fencing(markdown).forEach(({ line, fenced }, index) => {
    if (!fenced) return
    const command = line.split(/\s#|\|/, 1)[0].trim()
    const [program, ...argv] = command.split(/\s+/)
    if (program !== 'breakpoint') return
    const parsed = parseArgv(argv, '/')
    if (parsed.kind === 'error') {
      findings.push(`line ${index + 1}: \`${command}\` is refused by the CLI: ${parsed.message}`)
    }
  })
  return findings
}
