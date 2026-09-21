import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  LineBuffer,
  encodeLine,
  exitCodeFor,
  failure,
  parseRequestLine,
  parseResponseLine,
  success
} from './protocol'

describe('encodeLine', () => {
  it('writes one newline-terminated JSON line', () => {
    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n')
  })

  it('never emits an embedded newline, so one message is always one line', () => {
    const line = encodeLine({ message: 'two\nlines' })
    expect(line.indexOf('\n')).toBe(line.length - 1)
  })
})

describe('LineBuffer', () => {
  it('yields nothing until a newline arrives', () => {
    const buffer = new LineBuffer()
    expect(buffer.push('{"a":')).toEqual([])
    expect(buffer.push('1}\n')).toEqual(['{"a":1}'])
  })

  it('yields several lines from one chunk', () => {
    expect(new LineBuffer().push('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('drops an empty line rather than reporting it as a message', () => {
    expect(new LineBuffer().push('a\n\nb\n')).toEqual(['a', 'b'])
  })

  it('holds a trailing partial line back for the next chunk', () => {
    const buffer = new LineBuffer()
    expect(buffer.push('a\nb')).toEqual(['a'])
    expect(buffer.push('c\n')).toEqual(['bc'])
  })
})

describe('parseRequestLine', () => {
  it('accepts a well-formed request', () => {
    const result = parseRequestLine('{"id":"1","route":"app.quit"}')
    expect(result).toEqual({ ok: true, request: { id: '1', route: 'app.quit', params: undefined } })
  })

  it('carries params through untouched', () => {
    const result = parseRequestLine('{"id":"1","route":"app.quit","params":{"force":true}}')
    expect(result.ok && result.request.params).toEqual({ force: true })
  })

  it('rejects unparseable JSON as invalid_request', () => {
    const result = parseRequestLine('{not json')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid_request')
  })

  it('rejects a request with no route', () => {
    const result = parseRequestLine('{"id":"1"}')
    expect(!result.ok && result.error.code).toBe('invalid_request')
  })

  it('rejects a request with no id, because a reply could not be addressed', () => {
    const result = parseRequestLine('{"route":"app.quit"}')
    expect(!result.ok && result.error.code).toBe('invalid_request')
  })

  it('accepts an undeclared route name here — the table, not the parser, rejects it', () => {
    expect(parseRequestLine('{"id":"1","route":"nope.nope"}').ok).toBe(true)
  })
})

describe('parseResponseLine', () => {
  it('reads back a success envelope', () => {
    const line = encodeLine(success('7', { quitting: true }))
    const result = parseResponseLine(line.trim())
    expect(result).toEqual({
      ok: true,
      response: { id: '7', ok: true, payload: { quitting: true } }
    })
  })

  it('reads back a failure envelope', () => {
    const line = encodeLine(failure('7', 'unknown_route', 'no such route'))
    const result = parseResponseLine(line.trim())
    expect(result.ok && result.response.ok).toBe(false)
  })

  it('rejects a reply that is neither', () => {
    const result = parseResponseLine('{"id":"7"}')
    expect(!result.ok && result.error.code).toBe('invalid_request')
  })
})

describe('exitCodeFor', () => {
  it('maps a usage mistake to 2', () => {
    expect(exitCodeFor('invalid_usage')).toBe(2)
  })

  it('maps an app that is not there to 3', () => {
    expect(exitCodeFor('app_not_running')).toBe(3)
  })

  it('maps everything else to 1', () => {
    expect(exitCodeFor('unknown_route')).toBe(1)
    expect(exitCodeFor('internal_error')).toBe(1)
    expect(exitCodeFor('invalid_params')).toBe(1)
  })

  it('never returns 4 or 5, which Phase 6 claims', () => {
    for (const code of ERROR_CODES) {
      expect([1, 2, 3]).toContain(exitCodeFor(code))
    }
  })
})
