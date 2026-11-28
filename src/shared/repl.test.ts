import { describe, expect, it } from 'vitest'
import type { Evaluation } from './console'
import { NO_CONSOLE_FILTER, type ConsoleFilter } from './console-rows'
import {
  answerExchange,
  EMPTY_REPL_HISTORY,
  followFloor,
  MAX_REPL_HISTORY,
  mergeLines,
  refuseExchange,
  remember,
  replLines,
  sendExchange,
  stepHistory,
  type ReplExchange,
  type ReplHistory
} from './repl'

function typed(...expressions: string[]): ReplHistory {
  return expressions.reduce(remember, EMPTY_REPL_HISTORY)
}

describe('REPL history', () => {
  it('steps back from the newest, and no further than the oldest', () => {
    let history = typed('a', 'b')
    const first = stepHistory(history, 'back', '')!
    expect(first.text).toBe('b')
    history = first.history
    const second = stepHistory(history, 'back', 'b')!
    expect(second.text).toBe('a')
    expect(stepHistory(second.history, 'back', 'a')).toBeNull()
  })

  it('steps forward again, and off the newest end back to what was being typed', () => {
    const back = stepHistory(typed('a', 'b'), 'back', 'half-typ')!
    const older = stepHistory(back.history, 'back', back.text)!
    const newer = stepHistory(older.history, 'forward', older.text)!
    expect(newer.text).toBe('b')
    const fresh = stepHistory(newer.history, 'forward', newer.text)!
    expect(fresh).toEqual({
      history: { entries: ['a', 'b'], at: null, draft: '' },
      text: 'half-typ'
    })
    expect(stepHistory(fresh.history, 'forward', 'half-typ')).toBeNull()
  })

  it('has nowhere to go with nothing typed yet', () => {
    expect(stepHistory(EMPTY_REPL_HISTORY, 'back', 'x')).toBeNull()
    expect(stepHistory(EMPTY_REPL_HISTORY, 'forward', 'x')).toBeNull()
  })

  it('keeps an expression evaluated twice running once, and returns to a fresh line', () => {
    const stepped = stepHistory(typed('a'), 'back', '')!.history
    expect(remember(stepped, 'a')).toEqual({ entries: ['a'], at: null, draft: '' })
    expect(typed('a', 'b', 'a').entries).toEqual(['a', 'b', 'a'])
  })

  it('keeps the newest expressions only', () => {
    const many = typed(...Array.from({ length: MAX_REPL_HISTORY + 5 }, (_, i) => `x${i}`))
    expect(many.entries).toHaveLength(MAX_REPL_HISTORY)
    expect(many.entries.at(-1)).toBe(`x${MAX_REPL_HISTORY + 4}`)
  })
})

describe('REPL lines', () => {
  const mobile: Evaluation = { pane: 'm', outcome: 'value', text: '390' }
  const desktop: Evaluation = { pane: 'd', outcome: 'thrown', text: 'Uncaught TypeError: x' }

  function asked(cursor: number, results: Evaluation[] | null, id = cursor): ReplExchange {
    const [sent] = sendExchange([], { id, cursor, time: 0, expression: 'innerWidth', pane: null })
    return results === null ? sent : answerExchange([sent], id, results, 1)[0]
  }

  it('draws the expression, then one answer per pane beneath it, each tagged with its pane', () => {
    const lines = replLines([asked(4, [mobile, desktop])], NO_CONSOLE_FILTER)
    expect(lines.map((line) => line.kind)).toEqual(['input', 'result', 'result'])
    expect(lines.flatMap((line) => (line.kind === 'result' ? [line.evaluation.pane] : []))).toEqual(
      ['m', 'd']
    )
    expect(new Set(lines.map((line) => line.cursor))).toEqual(new Set([4]))
  })

  it('draws an expression still waiting for its answers', () => {
    expect(replLines([asked(4, null)], NO_CONSOLE_FILTER).map((line) => line.kind)).toEqual([
      'input'
    ])
  })

  it('draws a refusal as one failed answer', () => {
    const [sent] = sendExchange([], { id: 1, cursor: 2, time: 0, expression: '1', pane: 'gone' })
    const [refused] = refuseExchange([sent], 1, 'no pane gone in the open project', 3)
    expect(refused.results).toEqual([
      { pane: 'gone', outcome: 'failed', text: 'no pane gone in the open project' }
    ])
  })

  it('is cleared when the display floor rises, so Clear clears it too', () => {
    const sent = [asked(4, [mobile]), asked(5, null)]
    expect(followFloor(sent, null, 9)).toEqual({ exchanges: sent, seen: 9 })
    expect(followFloor(sent, 9, 9)).toEqual({ exchanges: sent, seen: 9 })
    expect(followFloor(sent, 9, 12)).toEqual({ exchanges: [], seen: 12 })
  })

  it('narrows answers by the console filter, and drops an expression with none left', () => {
    const onlyMobile: ConsoleFilter = { ...NO_CONSOLE_FILTER, panes: new Set(['m']) }
    expect(replLines([asked(4, [mobile, desktop])], onlyMobile)).toHaveLength(2)
    const errors: ConsoleFilter = { ...NO_CONSOLE_FILTER, levels: new Set(['error']) }
    const thrown = replLines([asked(4, [mobile, desktop])], errors)
    expect(
      thrown.flatMap((line) => (line.kind === 'result' ? [line.evaluation.pane] : []))
    ).toEqual(['d'])
    const elsewhere: ConsoleFilter = { ...NO_CONSOLE_FILTER, panes: new Set(['t']) }
    expect(replLines([asked(4, [mobile, desktop])], elsewhere)).toEqual([])
    const text: ConsoleFilter = { ...NO_CONSOLE_FILTER, text: 'typeerror' }
    expect(replLines([asked(4, [mobile, desktop])], text)).toHaveLength(2)
  })

  it('goes after every console line at its cursor and before every later one', () => {
    const console = [
      { key: 'g3', cursor: 3 },
      { key: 'g4', cursor: 4 },
      { key: 'e4', cursor: 4 },
      { key: 'g6', cursor: 6 }
    ]
    const repl = [
      { key: 'r1', cursor: 4 },
      { key: 'r1.0', cursor: 4 },
      { key: 'r2', cursor: 7 }
    ]
    expect(mergeLines(console, repl).map((line) => line.key)).toEqual([
      'g3',
      'g4',
      'e4',
      'r1',
      'r1.0',
      'g6',
      'r2'
    ])
  })
})
