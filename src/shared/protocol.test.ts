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

describe('the error codes', () => {
  it('are the stable upper-snake strings #6 settled, so nothing branches on wording', () => {
    for (const code of ERROR_CODES) {
      expect(code, `${code} is not a stable code`).toMatch(/^[A-Z][A-Z_]*$/)
    }
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
    expect(!result.ok && result.error.code).toBe('INVALID_REQUEST')
  })

  it('rejects a request with no route', () => {
    const result = parseRequestLine('{"id":"1"}')
    expect(!result.ok && result.error.code).toBe('INVALID_REQUEST')
  })

  it('rejects a request with no id, because a reply could not be addressed', () => {
    const result = parseRequestLine('{"route":"app.quit"}')
    expect(!result.ok && result.error.code).toBe('INVALID_REQUEST')
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
      response: { id: '7', ok: true, data: { quitting: true } }
    })
  })

  it('reads back a failure envelope', () => {
    const line = encodeLine(failure('7', 'UNKNOWN_ROUTE', 'no such route'))
    const result = parseResponseLine(line.trim())
    expect(result.ok && result.response.ok).toBe(false)
  })

  it('carries details through when a route sent them', () => {
    const line = encodeLine(failure('7', 'INVALID_PARAMS', 'bad', { field: 'force' }))
    const result = parseResponseLine(line.trim())
    expect(result.ok && !result.response.ok && result.response.error.details).toEqual({
      field: 'force'
    })
  })

  it('leaves details off entirely when there are none', () => {
    expect(failure('7', 'UNKNOWN_ROUTE', 'no such route').error).not.toHaveProperty('details')
  })

  it('rejects a reply that is neither', () => {
    const result = parseResponseLine('{"id":"7"}')
    expect(!result.ok && result.error.code).toBe('INVALID_REQUEST')
  })
})

describe('exitCodeFor', () => {
  it('maps a usage mistake to 2', () => {
    expect(exitCodeFor('INVALID_USAGE')).toBe(2)
  })

  it('maps an app that is not there to 3', () => {
    expect(exitCodeFor('APP_NOT_RUNNING')).toBe(3)
  })

  it('maps everything else to 1', () => {
    expect(exitCodeFor('UNKNOWN_ROUTE')).toBe(1)
    expect(exitCodeFor('INTERNAL_ERROR')).toBe(1)
    expect(exitCodeFor('INVALID_PARAMS')).toBe(1)
    expect(exitCodeFor('TIMEOUT')).toBe(1)
  })

  it('never returns 4 or 5, which Phase 6 claims', () => {
    for (const code of ERROR_CODES) {
      expect([1, 2, 3]).toContain(exitCodeFor(code))
    }
  })
})
