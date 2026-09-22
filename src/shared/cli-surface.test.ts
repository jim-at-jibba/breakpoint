import { describe, expect, expectTypeOf, it } from 'vitest'
import { ROUTE_NAMES } from './routes'
import {
  CLI_COMMANDS,
  CLI_FLAGS,
  EXIT_CODES,
  helpText,
  parseArgv,
  type CliCommandSpec,
  type ParsedValue
} from './cli-surface'
import type { LogRead, ReadParams } from './event-log'
import { foldPaneStatus } from './panes'
import { createProject } from './project'
import { paneStatusesFor, type StateSnapshot } from './state'

describe('the declared surface', () => {
  it('checks command parsers against their route parameters', () => {
    expectTypeOf<CliCommandSpec<'log.read'>['parseParams']>().returns.toEqualTypeOf<
      ParsedValue<ReadParams>
    >()
    expectTypeOf<CliCommandSpec<'project.open'>['parseParams']>().returns.toEqualTypeOf<
      ParsedValue<{ path: string }>
    >()
    expectTypeOf<CliCommandSpec<'app.quit'>['parseParams']>().returns.toEqualTypeOf<
      ParsedValue<undefined>
    >()
  })

  it('points every command at a declared route', () => {
    for (const command of CLI_COMMANDS) {
      expect(ROUTE_NAMES).toContain(command.route)
    }
  })

  it('names every flag with a double dash', () => {
    for (const flag of CLI_FLAGS) {
      expect(flag.name).toMatch(/^--[a-z][a-z-]*$/)
    }
  })

  it('declares exit codes 0 to 5, with 4 and 5 reserved for Phase 6', () => {
    expect(EXIT_CODES.map((code) => code.code)).toEqual([0, 1, 2, 3, 4, 5])
    expect(EXIT_CODES.filter((code) => code.status === 'reserved').map((c) => c.code)).toEqual([
      4, 5
    ])
  })

  it('mentions every command, flag and alias in the help text', () => {
    const help = helpText()
    for (const command of CLI_COMMANDS) expect(help).toContain(command.name)
    for (const flag of CLI_FLAGS) {
      expect(help).toContain(flag.name)
      for (const alias of flag.aliases ?? []) expect(help).toContain(alias)
    }
  })

  it('names every alias with a dash, so the parser can tell it from a command', () => {
    for (const flag of CLI_FLAGS) {
      for (const alias of flag.aliases ?? []) expect(alias).toMatch(/^-[a-zA-Z]$/)
    }
  })

  it('gives every flag something to set, so the declaration is what the parser reads', () => {
    const optionKeys = new Set(['json', 'noLaunch', 'verbose', 'help'])
    for (const flag of CLI_FLAGS) expect(optionKeys).toContain(flag.sets)
  })

  it('names every value flag with a double dash and shows what it takes', () => {
    for (const command of CLI_COMMANDS) {
      for (const flag of command.flags ?? []) {
        expect(flag.name).toMatch(/^--[a-z][a-z-]*$/)
        expect(flag.placeholder).toMatch(/^<.+>$/)
      }
    }
  })

  it('mentions every value flag in the help text, beside the command that takes it', () => {
    const help = helpText()
    for (const command of CLI_COMMANDS) {
      for (const flag of command.flags ?? []) {
        expect(help).toContain(`${flag.name} ${flag.placeholder}`)
      }
    }
  })

  it('renders every route payload without asking what shape it is', () => {
    for (const command of CLI_COMMANDS) {
      expect(typeof command.render({})).toBe('string')
    }
  })
})

describe('parseArgv', () => {
  it('reads a bare command', () => {
    const result = parseArgv(['quit'], '/cwd')
    expect(result.kind).toBe('command')
    expect(result.kind === 'command' && result.command.name).toBe('quit')
    expect(result.kind === 'command' && result.options).toEqual({
      json: false,
      noLaunch: false,
      verbose: false
    })
  })

  it('reads flags before and after the command', () => {
    const before = parseArgv(['--json', 'quit'], '/cwd')
    const after = parseArgv(['quit', '--json'], '/cwd')
    expect(before).toEqual(after)
    expect(before.kind === 'command' && before.options.json).toBe(true)
  })

  it('reads every flag together', () => {
    const result = parseArgv(['quit', '--json', '--no-launch', '--verbose'], '/cwd')
    expect(result.kind === 'command' && result.options).toEqual({
      json: true,
      noLaunch: true,
      verbose: true
    })
  })

  it('treats --help and its -h alias as help, wherever they appear', () => {
    expect(parseArgv(['--help'], '/cwd').kind).toBe('help')
    expect(parseArgv(['-h'], '/cwd').kind).toBe('help')
    expect(parseArgv(['quit', '--help'], '/cwd').kind).toBe('help')
  })

  it('treats no arguments as a usage mistake, not as help', () => {
    expect(parseArgv([], '/cwd')).toEqual({
      kind: 'error',
      message: expect.stringContaining('command'),
      options: { json: false, noLaunch: false, verbose: false }
    })
  })

  it('rejects an unknown command', () => {
    const result = parseArgv(['frobnicate'], '/cwd')
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('frobnicate')
  })

  it('rejects an unknown flag', () => {
    const result = parseArgv(['quit', '--turbo'], '/cwd')
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('--turbo')
  })

  it('rejects a second positional argument', () => {
    const result = parseArgv(['quit', 'now'], '/cwd')
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('now')
  })

  it('rejects a lone dash rather than reading it as a command', () => {
    expect(parseArgv(['-'], '/cwd').kind).toBe('error')
  })

  it.each([
    ['--json', 'quit', '--turbo'],
    ['quit', '--turbo', '--json'],
    ['quit', 'now', '--json'],
    ['frobnicate', '--json'],
    ['--json']
  ])('retains JSON mode for invalid arguments: %j', (...argv: string[]) => {
    const result = parseArgv(argv, '/cwd')
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.options.json).toBe(true)
  })
})

describe('opening a project from the command line', () => {
  const cwd = '/Users/dev/code/shop'

  it('reads a dot as the project at the working directory', () => {
    const result = parseArgv(['.'], cwd)
    expect(result.kind).toBe('command')
    expect(result.kind === 'command' && result.command.route).toBe('project.open')
    expect(result.kind === 'command' && result.params).toEqual({ path: cwd })
  })

  it.each([
    ['..', '/Users/dev/code'],
    ['../store', '/Users/dev/code/store'],
    ['./packages/web', '/Users/dev/code/shop/packages/web'],
    ['packages/web/', '/Users/dev/code/shop/packages/web'],
    ['/tmp/elsewhere', '/tmp/elsewhere']
  ])('resolves %s against the working directory before it leaves the terminal', (given, path) => {
    const result = parseArgv([given], cwd)
    expect(result.kind === 'command' && result.params).toEqual({ path })
  })

  it('still reads a bare word as a command, so a typo is a usage error and not a project', () => {
    const result = parseArgv(['frobnicate'], cwd)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toBe('unknown command frobnicate')
  })

  it('never reads a flag as a path, whatever it contains', () => {
    const result = parseArgv(['--out/dir'], cwd)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toBe('unknown flag --out/dir')
  })

  it('takes flags around the path', () => {
    const result = parseArgv(['--json', '.', '--no-launch'], cwd)
    expect(result.kind === 'command' && result.options).toEqual({
      json: true,
      noLaunch: true,
      verbose: false
    })
  })

  it('refuses a path and a command together', () => {
    expect(parseArgv(['.', 'state'], cwd).kind).toBe('error')
    expect(parseArgv(['state', '.'], cwd).kind).toBe('error')
  })

  it('reads state as the snapshot route with no params', () => {
    const result = parseArgv(['state'], cwd)
    expect(result.kind === 'command' && result.command.route).toBe('project.state')
    expect(result.kind === 'command' && result.params).toBeUndefined()
  })
})

describe('reading the event log from a terminal', () => {
  const read = (argv: string[]): ReturnType<typeof parseArgv> => parseArgv(argv, '/cwd')

  it('reads logs as the log route, with no cursor asked for', () => {
    const result = read(['logs'])
    expect(result.kind === 'command' && result.command.route).toBe('log.read')
    expect(result.kind === 'command' && result.params).toEqual({})
  })

  it('takes the cursor as a value, spelled either way', () => {
    for (const argv of [
      ['logs', '--since', '12'],
      ['logs', '--since=12']
    ]) {
      const result = read(argv)
      expect(result.kind === 'command' && result.params).toEqual({
        since: 12
      })
    }
  })

  it('takes the cursor with the other flags around it', () => {
    const result = read(['--json', 'logs', '--since', '12', '--verbose'])
    expect(result.kind === 'command' && result.params).toEqual({ since: 12 })
    expect(result.kind === 'command' && result.options).toEqual({
      json: true,
      noLaunch: false,
      verbose: true
    })
  })

  it('refuses a cursor that is not a position', () => {
    for (const given of ['later', '-1', '1.5', '']) {
      const result = read(['logs', `--since=${given}`])
      expect(result.kind, given).toBe('error')
    }
  })

  it('refuses a cursor with nothing after it', () => {
    const result = read(['logs', '--since'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('--since')
  })

  it.each(['--json', '--no-launch', '--verbose', '--help', '-h', '--since=12'])(
    'does not consume %s as a missing cursor value',
    (flag: string) => {
      const result = read(['logs', '--since', flag])
      expect(result.kind).toBe('error')
      expect(result.kind === 'error' && result.message).toBe('--since needs <cursor>')
      if (flag === '--json') expect(result.options.json).toBe(true)
      if (flag === '--no-launch') expect(result.options.noLaunch).toBe(true)
      if (flag === '--verbose') expect(result.options.verbose).toBe(true)
    }
  )

  it('validates every repeated cursor value and uses the last valid one', () => {
    const valid = read(['logs', '--since=1', '--since', '2'])
    expect(valid.kind === 'command' && valid.params).toEqual({ since: 2 })
    expect(read(['logs', '--since=invalid', '--since=2']).kind).toBe('error')
  })

  it('never reads the cursor as a second positional', () => {
    const result = read(['logs', '--since', '12'])
    expect(result.kind).toBe('command')
  })

  it('refuses the cursor on a command that does not take one, a path included', () => {
    for (const argv of [
      ['state', '--since', '12'],
      ['.', '--since', '12']
    ]) {
      const result = read(argv)
      expect(result.kind, argv.join(' ')).toBe('error')
      expect(result.kind === 'error' && result.message).toContain('--since')
    }
  })
})

describe('the log as a terminal reads it', () => {
  const logs = CLI_COMMANDS.find((command) => command.route === 'log.read')

  function render(read: LogRead): string {
    return logs?.render(read) ?? ''
  }

  it('says the log is quiet rather than printing nothing', () => {
    expect(render({ entries: [], cursor: 7 })).toContain('7')
  })

  it('marks shortened entry text in human output', () => {
    expect(
      render({
        entries: [
          {
            cursor: 1,
            time: 0,
            pane: null,
            type: 'project.openFailed',
            path: '/shortened',
            code: 'INVALID_PARAMS',
            message: 'shortened',
            truncated: ['path', 'message']
          }
        ],
        cursor: 1
      })
    ).toContain('[truncated: path, message]')
  })

  it('prints a pane lifecycle entry against its pane, saying what happened', () => {
    const text = render({
      entries: [
        { cursor: 3, time: 0, pane: 'p-1', type: 'pane.created', url: 'http://127.0.0.1:5173/' },
        {
          cursor: 4,
          time: 0,
          pane: 'p-1',
          type: 'pane.attachFailed',
          attempt: 1,
          retrying: true,
          message: 'Debugger is already attached to the target'
        },
        {
          cursor: 5,
          time: 0,
          pane: 'p-1',
          type: 'pane.geometryMismatch',
          expected: { width: 390, height: 844 },
          measured: { width: 390, height: 150 },
          message: 'drawn 390×150, declared 390×844 at this zoom'
        }
      ],
      cursor: 5
    })
    expect(text.split('\n')).toEqual([
      '3  p-1  created, loading http://127.0.0.1:5173/',
      '4  p-1  attachment failed (attempt 1, retrying after load): Debugger is already attached to the target',
      '5  p-1  degraded: drawn 390×150, declared 390×844 at this zoom'
    ])
  })

  it('prints a pane joining, changing size and leaving the project', () => {
    const text = render({
      entries: [
        {
          cursor: 6,
          time: 0,
          pane: 'p-2',
          type: 'pane.added',
          width: 1280,
          height: 800,
          preset: 'laptop'
        },
        { cursor: 7, time: 0, pane: 'p-2', type: 'pane.resized', width: 800, height: 1280 },
        {
          cursor: 8,
          time: 0,
          pane: 'p-3',
          type: 'pane.added',
          width: 1024,
          height: 768,
          preset: null
        },
        { cursor: 9, time: 0, pane: 'p-3', type: 'pane.removed' }
      ],
      cursor: 9
    })
    expect(text.split('\n')).toEqual([
      '6  p-2  added at 1280×800 from the laptop preset',
      '7  p-2  resized to 800×1280',
      '8  p-3  added at 1024×768',
      '9  p-3  removed from the project'
    ])
  })

  it('says what was evicted before what it is about to print', () => {
    const text = render({
      entries: [
        {
          cursor: 41,
          time: 0,
          pane: null,
          type: 'project.openFailed',
          path: '/repos/shop',
          code: 'PROJECT_UNREADABLE',
          message: '/repos/shop: corrupt'
        }
      ],
      cursor: 41,
      droppedBefore: 40
    })
    const [first, second] = text.split('\n')
    expect(first).toContain('40')
    expect(second).toContain('41')
    expect(second).toContain('/repos/shop')
    expect(second).toContain('PROJECT_UNREADABLE')
  })
})

describe('the state as a terminal reads it', () => {
  const state = CLI_COMMANDS.find((command) => command.route === 'project.state')
  const shop = createProject('/repos/shop')
  const [mobile, tablet] = shop.panes

  it('lists each pane with its size, and says which are degraded and why', () => {
    const panes = paneStatusesFor(shop, {})
    panes[tablet.id] = foldPaneStatus(panes[tablet.id], {
      type: 'attachFailed',
      message: 'Debugger is already attached to the target'
    })
    const snapshot: StateSnapshot = { revision: 3, cursor: 9, project: shop, panes }

    const lines = (state?.render(snapshot) ?? '').split('\n')
    expect(lines).toContain(`  ${mobile.name.padEnd(10)}390×844 @3x`)
    expect(lines).toContain(
      '  Tablet    820×1180 @2x  degraded: attachment: Debugger is already attached to the target'
    )
  })
})

describe('breakpoint open', () => {
  const cwd = '/Users/dev/code/shop'

  it('sends what was typed, so the route expands it the one way', () => {
    const result = parseArgv(['open', '3000'], cwd)
    expect(result.kind).toBe('command')
    expect(result.kind === 'command' && result.command.route).toBe('project.navigate')
    expect(result.kind === 'command' && result.params).toEqual({ url: '3000' })
  })

  it.each(['https://staging.example.com/cart', 'localhost:3000/checkout', ':5173'])(
    'takes %s as its one argument',
    (url: string) => {
      const result = parseArgv(['open', url], cwd)
      expect(result.kind === 'command' && result.params).toEqual({ url })
    }
  )

  it('reads flags on either side of the URL', () => {
    const before = parseArgv(['--json', 'open', '3000'], cwd)
    const after = parseArgv(['open', '3000', '--json'], cwd)
    expect(before).toEqual(after)
    expect(before.kind === 'command' && before.options.json).toBe(true)
  })

  it('is a usage error with no URL', () => {
    const result = parseArgv(['open'], cwd)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toBe('open needs <url>')
  })

  it('is a usage error with a second URL', () => {
    const result = parseArgv(['open', '3000', '3001'], cwd)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('3001')
  })

  it('refuses an argument for a command that takes none', () => {
    const result = parseArgv(['state', 'now'], cwd)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toBe('unexpected argument now')
  })

  it('still reads a path as opening a project, not as navigating', () => {
    const result = parseArgv(['.'], cwd)
    expect(result.kind === 'command' && result.command.route).toBe('project.open')
  })

  it('renders the navigation on a terminal', () => {
    const open = CLI_COMMANDS.find((command) => command.name === 'open')!
    expect(open.render({ url: 'http://localhost:3000/', panes: ['a', 'b', 'c'] })).toBe(
      'Pointed 3 panes at http://localhost:3000/'
    )
    expect(open.render({ url: 'http://localhost:3000/', panes: ['a'] })).toContain('1 pane at')
  })

  it('shows its argument in the help text', () => {
    expect(helpText()).toContain('open <url>')
  })
})
