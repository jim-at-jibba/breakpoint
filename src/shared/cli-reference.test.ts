import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  brokenExamples,
  DECLARED_SURFACE,
  referenceDrift,
  type DeclaredSurface
} from './cli-reference'

/** A surface small enough to write its reference out by hand. */
const SMALL: DeclaredSurface = {
  commands: ['<path>', 'quit'],
  flags: ['--json', '--help', '-h'],
  exitCodes: [0, 2],
  errorCodes: ['INVALID_USAGE'],
  routes: ['app.quit', 'project.open']
}

/** The reference for `SMALL`, in the shape the Docs write it. */
const REFERENCE = `
## Commands

### \`breakpoint .\` and \`breakpoint <path>\`

### \`breakpoint quit\`

## Flags

| Flag | What it does |
| --- | --- |
| \`--json\` | Prints JSON |
| \`--help\`, \`-h\` | Prints the help |

## Exit codes

| Code | Meaning |
| --- | --- |
| \`0\` | Succeeded |
| \`2\` | Usage |

## Error codes

| Code | Exit | Meaning |
| --- | --- | --- |
| \`INVALID_USAGE\` | \`2\` | The arguments could not be parsed |

## Routes

| Route | Params | Payload | Reached by |
| --- | --- | --- | --- |
| \`app.quit\` | none | \`{ "quitting": true }\` | \`breakpoint quit\` |
| \`project.open\` | \`{ "path": "/abs/repo" }\` | the state snapshot | \`breakpoint .\` |
`

describe('the reference against the declared surface', () => {
  it('finds nothing to report when the two agree', () => {
    expect(referenceDrift(REFERENCE, SMALL)).toEqual([])
  })

  it.each([
    ['command', { commands: [...SMALL.commands, 'shot'] }, 'command `shot`'],
    ['flag', { flags: [...SMALL.flags, '--headless'] }, 'flag `--headless`'],
    ['exit code', { exitCodes: [...SMALL.exitCodes, 4] }, 'exit code `4`'],
    ['error code', { errorCodes: [...SMALL.errorCodes, 'TIMEOUT'] }, 'error code `TIMEOUT`'],
    ['route', { routes: [...SMALL.routes, 'panes.add'] }, 'route `panes.add`']
  ] as const)('fails a %s that is declared and not documented', (_kind, added, named) => {
    expect(referenceDrift(REFERENCE, { ...SMALL, ...added })).toEqual([
      `${named} is declared but the docs reference does not document it`
    ])
  })

  it.each([
    ['command', { commands: ['<path>'] }, 'command `quit`'],
    ['flag alias', { flags: ['--json', '--help'] }, 'flag `-h`'],
    ['exit code', { exitCodes: [0] }, 'exit code `2`'],
    ['error code', { errorCodes: [] }, 'error code `INVALID_USAGE`'],
    ['route', { routes: ['project.open'] }, 'route `app.quit`']
  ] as const)('fails a %s that is documented and no longer declared', (_kind, kept, named) => {
    expect(referenceDrift(REFERENCE, { ...SMALL, ...kept })).toEqual([
      `${named} is documented but the CLI no longer declares it`
    ])
  })

  it('reads a value flag by its name, not its placeholder', () => {
    const reference = REFERENCE.replace(
      '| `--json` |',
      '| `--since <cursor>` | Reads what followed |\n| `--json` |'
    )
    expect(referenceDrift(reference, { ...SMALL, flags: [...SMALL.flags, '--since'] })).toEqual([])
  })

  it('fails a reference that has lost a section rather than passing it as empty', () => {
    const reference = REFERENCE.replace('## Routes', '## Route table')
    expect(referenceDrift(reference, SMALL)).toEqual([
      'the docs reference has no `## Routes` section'
    ])
  })
})

describe('the fenced examples', () => {
  it('passes a command the CLI accepts, past its comment and its pipe', () => {
    const page = '```sh\nbreakpoint state --json | jq .cursor   # hand this to `logs`\n```\n'
    expect(brokenExamples(page)).toEqual([])
  })

  it('fails a command the CLI rejects, naming the line and why', () => {
    const page = 'Wait for it:\n\n```sh\nbreakpoint logs --wait\n```\n'
    expect(brokenExamples(page)).toEqual([
      'line 4: `breakpoint logs --wait` is refused by the CLI: --wait is not a flag of logs'
    ])
  })

  it('fails a flag the CLI does not have, as #29 found on the quickstart', () => {
    const page = '```sh\nbreakpoint . --watch --json\n```\n'
    expect(brokenExamples(page)).toEqual([
      'line 2: `breakpoint . --watch --json` is refused by the CLI: unknown flag --watch'
    ])
  })

  it('passes asking for the help', () => {
    expect(brokenExamples('```sh\nbreakpoint --help\n```\n')).toEqual([])
  })

  it('reads only fenced lines that run breakpoint, not prose or other programs', () => {
    const page = [
      'Run `breakpoint --nope` and nothing happens.',
      '```sh',
      'ln -s "$PWD/bin/breakpoint" /usr/local/bin/breakpoint',
      '# stderr: breakpoint: connected, calling app.quit',
      '```'
    ].join('\n')
    expect(brokenExamples(page)).toEqual([])
  })
})

const DOCS = fileURLToPath(new URL('../../sites/web/src/content/docs/', import.meta.url))
const CLI_REFERENCE = join(DOCS, 'docs/cli.md')

describe("the Docs' CLI reference", () => {
  const reference = readFileSync(CLI_REFERENCE, 'utf8')

  it('documents exactly what the code declares', () => {
    expect(referenceDrift(reference)).toEqual([])
  })

  // The deliberate omission the ticket asks for: a command added to the code and not to
  // the docs is a failure here, and so is the same command's docs outliving the code.
  it('fails a command added to the CLI without a heading in the reference', () => {
    const added = { ...DECLARED_SURFACE, commands: [...DECLARED_SURFACE.commands, 'shot'] }
    expect(referenceDrift(reference, added)).toEqual([
      'command `shot` is declared but the docs reference does not document it'
    ])
  })

  it('fails a command dropped from the CLI whose heading is still in the reference', () => {
    const dropped = {
      ...DECLARED_SURFACE,
      commands: DECLARED_SURFACE.commands.filter((name) => name !== 'logs')
    }
    expect(referenceDrift(reference, dropped)).toEqual([
      'command `logs` is documented but the CLI no longer declares it'
    ])
  })
})

/** Every page of the Docs, not only the reference (#29). */
function docsPages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return docsPages(path)
    return /\.mdx?$/.test(entry.name) ? [path] : []
  })
}

describe("the Docs' examples", () => {
  const pages = docsPages(DOCS)

  it('are read from every page, the reference and the quickstart among them', () => {
    expect(pages).toEqual(expect.arrayContaining([CLI_REFERENCE, join(DOCS, 'docs/quickstart.md')]))
  })

  it.each(pages.map((path) => [path.slice(DOCS.length), path]))(
    'in %s all run against the CLI as it stands',
    (_page, path) => {
      expect(brokenExamples(readFileSync(path, 'utf8'))).toEqual([])
    }
  )
})
