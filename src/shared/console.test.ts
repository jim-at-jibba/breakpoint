import { describe, expect, it } from 'vitest'
import {
  CONSOLE_ENABLE_COMMANDS,
  ConsoleCapture,
  consoleEntryFor,
  MAX_STACK_FRAMES
} from './console'

/** Payloads shaped as Chromium sends them, trimmed to the fields that matter here. */

const APP = 'http://localhost:3000/src/App.tsx'

function callFrame(
  functionName: string,
  lineNumber: number,
  columnNumber: number,
  url = APP
): Record<string, unknown> {
  return { functionName, scriptId: '12', url, lineNumber, columnNumber }
}

function consoleCall(
  type: string,
  args: unknown[],
  frames = [callFrame('render', 9, 4)]
): Record<string, unknown> {
  return {
    type,
    args,
    executionContextId: 1,
    timestamp: 1_700_000_000_000,
    stackTrace: { callFrames: frames }
  }
}

const text = (value: string): Record<string, unknown> => ({ type: 'string', value })

describe('the domains the attachment enables', () => {
  it('are Runtime and Log, and nothing else (ADR-0019)', () => {
    expect(CONSOLE_ENABLE_COMMANDS).toEqual(['Runtime.enable', 'Log.enable'])
  })
})

describe('a console call', () => {
  it('becomes a message at its level, with its text, one preview per argument, and where it was made', () => {
    expect(
      consoleEntryFor(
        'Runtime.consoleAPICalled',
        consoleCall('log', [text('ready'), { type: 'number', value: 3, description: '3' }])
      )
    ).toEqual({
      type: 'console.message',
      level: 'log',
      source: 'console',
      text: 'ready 3',
      args: ['ready', '3'],
      url: null,
      // One-based, the way an editor counts, and not yet resolved.
      location: { url: APP, line: 10, column: 5, resolution: 'failed' },
      stack: [{ function: 'render', url: APP, line: 10, column: 5, resolution: 'failed' }]
    })
  })

  it.each([
    ['debug', 'debug'],
    ['log', 'log'],
    ['info', 'info'],
    ['warning', 'warn'],
    ['error', 'error'],
    ['assert', 'error'],
    ['trace', 'log'],
    ['table', 'log'],
    ['dir', 'log'],
    ['count', 'log'],
    ['timeEnd', 'log'],
    ['startGroup', 'log'],
    ['clear', 'log']
  ])('of type %s is at level %s', (type, level) => {
    expect(
      consoleEntryFor('Runtime.consoleAPICalled', consoleCall(type, [text('x')]))
    ).toMatchObject({ level })
  })

  it('previews every kind of value as it would print, not as JSON', () => {
    const entry = consoleEntryFor(
      'Runtime.consoleAPICalled',
      consoleCall('log', [
        { type: 'undefined' },
        { type: 'object', subtype: 'null', value: null },
        { type: 'boolean', value: false },
        { type: 'number', unserializableValue: 'NaN', description: 'NaN' },
        { type: 'bigint', unserializableValue: '12n', description: '12n' },
        { type: 'symbol', description: 'Symbol(tag)' },
        { type: 'function', className: 'Function', description: 'function go() {}' },
        {
          type: 'object',
          className: 'Object',
          description: 'Object',
          preview: {
            type: 'object',
            description: 'Object',
            overflow: false,
            properties: [
              { name: 'id', type: 'number', value: '7' },
              { name: 'name', type: 'string', value: 'Ada' },
              { name: 'tags', type: 'object', subtype: 'array', value: 'Array(2)' },
              { name: 'none', type: 'object', subtype: 'null', value: 'null' }
            ]
          }
        },
        {
          type: 'object',
          subtype: 'array',
          className: 'Array',
          description: 'Array(40)',
          preview: {
            type: 'object',
            subtype: 'array',
            description: 'Array(40)',
            overflow: true,
            properties: [
              { name: '0', type: 'number', value: '1' },
              { name: '1', type: 'number', value: '2' }
            ]
          }
        },
        {
          type: 'object',
          subtype: 'map',
          className: 'Map',
          description: 'Map(1)',
          preview: {
            type: 'object',
            subtype: 'map',
            description: 'Map(1)',
            overflow: false,
            properties: [],
            entries: [
              {
                key: { type: 'string', description: 'a', overflow: false, properties: [] },
                value: { type: 'number', description: '1', overflow: false, properties: [] }
              }
            ]
          }
        },
        {
          type: 'object',
          className: 'Widget',
          description: 'Widget',
          preview: {
            type: 'object',
            description: 'Widget',
            overflow: false,
            properties: [{ name: 'size', type: 'number', value: '2' }]
          }
        },
        { type: 'object', subtype: 'node', className: 'HTMLDivElement', description: 'div#app' }
      ])
    )
    expect(entry?.type === 'console.message' && entry.args).toEqual([
      'undefined',
      'null',
      'false',
      'NaN',
      '12n',
      'Symbol(tag)',
      'function go() {}',
      "{id: 7, name: 'Ada', tags: Array(2), none: null}",
      'Array(40) [1, 2, …]',
      "Map(1) {'a' => 1}",
      'Widget {size: 2}',
      'div#app'
    ])
  })

  it('previews an error by its message, leaving the stack to the stack', () => {
    const entry = consoleEntryFor(
      'Runtime.consoleAPICalled',
      consoleCall('error', [
        text('failed:'),
        {
          type: 'object',
          subtype: 'error',
          className: 'TypeError',
          description:
            'TypeError: nope\n  multi-line\n    at render (http://localhost:3000/src/App.tsx:10:5)'
        }
      ])
    )
    expect(entry).toMatchObject({
      level: 'error',
      text: 'failed: TypeError: nope\n  multi-line',
      args: ['failed:', 'TypeError: nope\n  multi-line']
    })
  })

  it('applies format specifiers the way the console does', () => {
    const entry = consoleEntryFor(
      'Runtime.consoleAPICalled',
      consoleCall('log', [
        text('%s is %d%% done in %cred%c, %o, %f, %i'),
        text('build'),
        { type: 'number', value: 42.9, description: '42.9' },
        text('color: red'),
        text(''),
        { type: 'object', className: 'Object', description: 'Object' },
        { type: 'number', value: 1.5, description: '1.5' },
        { type: 'number', value: -2.5, description: '-2.5' },
        text('left over')
      ])
    )
    expect(entry).toMatchObject({ text: 'build is 42% done in red, Object, 1.5, -2 left over' })
    // Previews are of the arguments as given, so nothing is lost to formatting.
    expect(entry?.type === 'console.message' && entry.args).toHaveLength(9)
  })

  it('leaves a specifier with no argument to fill it as written', () => {
    expect(
      consoleEntryFor('Runtime.consoleAPICalled', consoleCall('log', [text('100%s')]))
    ).toMatchObject({ text: '100%s' })
  })

  it('has no location when the page gave no stack', () => {
    const call = { ...consoleCall('log', [text('x')]), stackTrace: undefined }
    expect(consoleEntryFor('Runtime.consoleAPICalled', call)).toMatchObject({
      location: null,
      stack: []
    })
  })

  it(`keeps at most ${MAX_STACK_FRAMES} frames, innermost first`, () => {
    const frames = Array.from({ length: 200 }, (_, index) => callFrame(`f${index}`, index, 0))
    const entry = consoleEntryFor('Runtime.consoleAPICalled', consoleCall('trace', [], frames))
    if (entry?.type !== 'console.message') throw new Error('not a message')
    expect(entry.stack).toHaveLength(MAX_STACK_FRAMES)
    expect(entry.stack[0]).toMatchObject({ function: 'f0', line: 1 })
  })
})

describe('an exception', () => {
  const thrown = {
    type: 'object',
    subtype: 'error',
    className: 'TypeError',
    description:
      "TypeError: Cannot read properties of undefined (reading 'map')\n    at render (http://localhost:3000/src/App.tsx:4:11)"
  }

  function details(changes: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      timestamp: 1_700_000_000_000,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 3,
        columnNumber: 10,
        scriptId: '12',
        url: APP,
        stackTrace: { callFrames: [callFrame('render', 3, 10), callFrame('', 20, 0)] },
        exception: thrown,
        executionContextId: 1,
        ...changes
      }
    }
  }

  it('uncaught becomes a console.exception with its headline, what was thrown, and a trimmed stack', () => {
    expect(consoleEntryFor('Runtime.exceptionThrown', details())).toEqual({
      type: 'console.exception',
      rejection: false,
      text: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')",
      error: "TypeError: Cannot read properties of undefined (reading 'map')",
      location: { url: APP, line: 4, column: 11, resolution: 'failed' },
      stack: [
        { function: 'render', url: APP, line: 4, column: 11, resolution: 'failed' },
        { function: '', url: APP, line: 21, column: 1, resolution: 'failed' }
      ]
    })
  })

  it('from an unhandled rejection is marked as one', () => {
    expect(
      consoleEntryFor(
        'Runtime.exceptionThrown',
        details({ text: 'Uncaught (in promise)', exception: text('no session') })
      )
    ).toMatchObject({
      type: 'console.exception',
      rejection: true,
      text: 'Uncaught (in promise) no session',
      error: 'no session'
    })
  })

  it('whose headline already says what was thrown does not say it twice', () => {
    expect(
      consoleEntryFor(
        'Runtime.exceptionThrown',
        details({
          text: "Uncaught SyntaxError: Unexpected token '}'",
          exception: { ...thrown, description: "SyntaxError: Unexpected token '}'" },
          stackTrace: undefined
        })
      )
    ).toMatchObject({
      text: "Uncaught SyntaxError: Unexpected token '}'",
      // With no stack, where it was reported is all there is.
      location: { url: APP, line: 4, column: 11 },
      stack: []
    })
  })

  it('with nothing thrown to preview keeps its headline alone', () => {
    expect(
      consoleEntryFor('Runtime.exceptionThrown', details({ exception: undefined }))
    ).toMatchObject({ text: 'Uncaught', error: null })
  })
})

describe("the browser's own messages", () => {
  function logEntry(entry: Record<string, unknown>): Record<string, unknown> {
    return { entry: { timestamp: 1_700_000_000_000, ...entry } }
  }

  it('carry the source that says what kind of failure it was, and what it was about', () => {
    expect(
      consoleEntryFor(
        'Log.entryAdded',
        logEntry({
          source: 'network',
          level: 'error',
          text: 'Failed to load resource: net::ERR_FAILED',
          url: 'http://127.0.0.1:4000/data.json'
        })
      )
    ).toEqual({
      type: 'console.message',
      level: 'error',
      source: 'network',
      text: 'Failed to load resource: net::ERR_FAILED',
      args: [],
      url: 'http://127.0.0.1:4000/data.json',
      location: null,
      stack: []
    })
  })

  it.each([
    ['verbose', 'debug'],
    ['info', 'info'],
    ['warning', 'warn'],
    ['error', 'error']
  ])('at level %s are at level %s', (level, expected) => {
    expect(
      consoleEntryFor('Log.entryAdded', logEntry({ source: 'deprecation', level, text: 'x' }))
    ).toMatchObject({ level: expected, source: 'deprecation' })
  })

  it('locate themselves by their stack, or by the line they name', () => {
    expect(
      consoleEntryFor(
        'Log.entryAdded',
        logEntry({
          source: 'violation',
          level: 'verbose',
          text: "[Violation] 'click' handler took 200ms",
          url: APP,
          lineNumber: 7,
          stackTrace: { callFrames: [callFrame('onClick', 7, 2)] }
        })
      )
    ).toMatchObject({
      url: APP,
      location: { url: APP, line: 8, column: 3 },
      stack: [{ function: 'onClick', line: 8 }]
    })
    expect(
      consoleEntryFor(
        'Log.entryAdded',
        logEntry({ source: 'security', level: 'error', text: 'CSP', url: APP, lineNumber: 2 })
      )
    ).toMatchObject({ location: { url: APP, line: 3, column: 1 }, stack: [] })
  })

  it('from a source this build does not know are kept as other rather than dropped', () => {
    expect(
      consoleEntryFor('Log.entryAdded', logEntry({ source: 'tomorrow', level: 'info', text: 'x' }))
    ).toMatchObject({ source: 'other' })
  })
})

describe('anything else the attachment hears', () => {
  it.each([
    ['Runtime.executionContextCreated', { context: { id: 1 } }],
    ['Runtime.exceptionRevoked', { reason: 'Handler added to rejected promise', exceptionId: 1 }],
    ['Emulation.virtualTimeBudgetExpired', {}],
    ['Runtime.consoleAPICalled', undefined],
    ['Runtime.consoleAPICalled', { type: 'log' }],
    ['Runtime.exceptionThrown', { exceptionDetails: null }],
    ['Log.entryAdded', { entry: 'nope' }]
  ])('%s is not an entry', (method, params) => {
    expect(consoleEntryFor(method, params)).toBeNull()
  })
})

describe('what a pane hears across its execution contexts', () => {
  const page = { id: 3, auxData: { isDefault: true, type: 'default' } }
  const electron = {
    id: 4,
    name: 'Electron Isolated Context',
    auxData: { isDefault: false, type: 'isolated' }
  }

  function said(context: number): Record<string, unknown> {
    return { ...consoleCall('warning', [text(`from ${context}`)]), executionContextId: context }
  }

  it("keeps the page's own output and drops what another world logs into it", () => {
    const capture = new ConsoleCapture()
    expect(capture.hear('Runtime.executionContextCreated', { context: page })).toBeNull()
    expect(capture.hear('Runtime.executionContextCreated', { context: electron })).toBeNull()

    expect(capture.hear('Runtime.consoleAPICalled', said(3))).toMatchObject({ text: 'from 3' })
    // Electron's own security warning, which is about the app and not about the page.
    expect(capture.hear('Runtime.consoleAPICalled', said(4))).toBeNull()
    expect(
      capture.hear('Runtime.exceptionThrown', {
        exceptionDetails: { text: 'Uncaught', executionContextId: 4 }
      })
    ).toBeNull()
  })

  it('forgets a world once its contexts are gone, so a reused id is judged afresh', () => {
    const capture = new ConsoleCapture()
    capture.hear('Runtime.executionContextCreated', { context: electron })
    capture.hear('Runtime.executionContextsCleared', {})
    capture.hear('Runtime.executionContextCreated', { context: { ...page, id: 4 } })
    expect(capture.hear('Runtime.consoleAPICalled', said(4))).toMatchObject({ text: 'from 4' })

    capture.hear('Runtime.executionContextCreated', { context: { ...electron, id: 9 } })
    capture.hear('Runtime.executionContextDestroyed', { executionContextId: 9 })
    capture.hear('Runtime.executionContextCreated', { context: { ...page, id: 9 } })
    expect(capture.hear('Runtime.consoleAPICalled', said(9))).toMatchObject({ text: 'from 9' })
  })

  it("keeps the browser's messages, which belong to no world", () => {
    const capture = new ConsoleCapture()
    capture.hear('Runtime.executionContextCreated', { context: electron })
    expect(
      capture.hear('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'x' } })
    ).toMatchObject({ source: 'network' })
  })
})
