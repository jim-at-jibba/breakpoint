import { describe, expect, it } from 'vitest'
import { ROUTE_NAMES } from './routes'
import { CLI_COMMANDS, CLI_FLAGS, EXIT_CODES, helpText, parseArgv } from './cli-surface'

describe('the declared surface', () => {
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

  it('renders every route payload without asking what shape it is', () => {
    for (const command of CLI_COMMANDS) {
      expect(typeof command.render({})).toBe('string')
    }
  })
})

describe('parseArgv', () => {
  it('reads a bare command', () => {
    const result = parseArgv(['quit'])
    expect(result.kind).toBe('command')
    expect(result.kind === 'command' && result.command.name).toBe('quit')
    expect(result.kind === 'command' && result.options).toEqual({
      json: false,
      noLaunch: false,
      verbose: false
    })
  })

  it('reads flags before and after the command', () => {
    const before = parseArgv(['--json', 'quit'])
    const after = parseArgv(['quit', '--json'])
    expect(before).toEqual(after)
    expect(before.kind === 'command' && before.options.json).toBe(true)
  })

  it('reads every flag together', () => {
    const result = parseArgv(['quit', '--json', '--no-launch', '--verbose'])
    expect(result.kind === 'command' && result.options).toEqual({
      json: true,
      noLaunch: true,
      verbose: true
    })
  })

  it('treats --help and its -h alias as help, wherever they appear', () => {
    expect(parseArgv(['--help']).kind).toBe('help')
    expect(parseArgv(['-h']).kind).toBe('help')
    expect(parseArgv(['quit', '--help']).kind).toBe('help')
  })

  it('treats no arguments as a usage mistake, not as help', () => {
    expect(parseArgv([])).toEqual({ kind: 'error', message: expect.stringContaining('command') })
  })

  it('rejects an unknown command', () => {
    const result = parseArgv(['frobnicate'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('frobnicate')
  })

  it('rejects an unknown flag', () => {
    const result = parseArgv(['quit', '--turbo'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('--turbo')
  })

  it('rejects a second positional argument', () => {
    const result = parseArgv(['quit', 'now'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.message).toContain('now')
  })

  it('rejects a lone dash rather than reading it as a command', () => {
    expect(parseArgv(['-']).kind).toBe('error')
  })
})
