import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONSOLE_HISTORY,
  foldConsoleBatch,
  foldConsoleRead,
  indexAtOrAfter,
  isConsoleEntry,
  type ConsoleBatch,
  type ConsoleEntry,
  type ConsoleHistory
} from './console-feed'
import type { Entry } from './event-log'

function said(cursor: number, pane = 'mobile', text = `entry ${cursor}`): ConsoleEntry {
  return {
    cursor,
    time: 0,
    pane,
    type: 'console.message',
    level: 'log',
    source: 'console',
    text,
    args: [text],
    url: null,
    location: null,
    stack: []
  }
}

function batch(after: number, cursor: number, ...entries: ConsoleEntry[]): ConsoleBatch {
  return { after, cursor, entries, evicted: [] }
}

function folded(history: ConsoleHistory, next: ConsoleBatch): ConsoleHistory {
  const result = foldConsoleBatch(history, next)
  if (result.gap) throw new Error('unexpected gap')
  return result.history
}

const cursors = (history: ConsoleHistory): number[] => history.entries.map((e) => e.cursor)

describe('folding console batches', () => {
  it('appends a batch that follows on from where the history is', () => {
    const history = folded(EMPTY_CONSOLE_HISTORY, batch(0, 3, said(1), said(3)))

    expect(history.cursor).toBe(3)
    expect(cursors(history)).toEqual([1, 3])
  })

  it('reports a gap when a batch follows on from a position the history never reached', () => {
    const history = folded(EMPTY_CONSOLE_HISTORY, batch(0, 3, said(1)))

    expect(foldConsoleBatch(history, batch(7, 9, said(9)))).toEqual({ gap: true })
  })

  it('accepts a batch that overlaps what a read already returned, without doubling it', () => {
    const history = folded(EMPTY_CONSOLE_HISTORY, batch(0, 5, said(4), said(5)))
    const next = folded(history, batch(3, 7, said(4), said(5), said(7)))

    expect(cursors(next)).toEqual([4, 5, 7])
    expect(next.cursor).toBe(7)
  })

  it('removes what a pane evicted, and only that pane’s', () => {
    const history = folded(
      EMPTY_CONSOLE_HISTORY,
      batch(0, 4, said(1, 'mobile'), said(2, 'tablet'), said(3, 'mobile'), said(4, 'tablet'))
    )
    const next = folded(history, {
      after: 4,
      cursor: 5,
      entries: [said(5, 'mobile')],
      evicted: [{ pane: 'mobile', through: 3 }]
    })

    expect(cursors(next)).toEqual([2, 4, 5])
  })

  it('drops an entry its own batch evicted, as a busy pane does within one frame', () => {
    const next = folded(EMPTY_CONSOLE_HISTORY, {
      after: 0,
      cursor: 3,
      entries: [said(1), said(2), said(3)],
      evicted: [{ pane: 'mobile', through: 1 }]
    })

    expect(cursors(next)).toEqual([2, 3])
  })

  it('applies a late batch’s evictions even when its entries are already held', () => {
    const history = folded(EMPTY_CONSOLE_HISTORY, batch(0, 6, said(1), said(2), said(6)))
    const next = folded(history, {
      after: 0,
      cursor: 3,
      entries: [],
      evicted: [{ pane: 'mobile', through: 2 }]
    })

    expect(cursors(next)).toEqual([6])
    expect(next.cursor).toBe(6)
  })
})

describe('folding a read', () => {
  it('keeps only console entries past the history, and moves to the read’s cursor', () => {
    const loaded: Entry = { cursor: 2, time: 0, pane: 'mobile', type: 'pane.loaded', url: 'x' }
    const history = foldConsoleRead(EMPTY_CONSOLE_HISTORY, {
      entries: [said(1), loaded, said(3)],
      cursor: 4
    })

    expect(cursors(history)).toEqual([1, 3])
    expect(history.cursor).toBe(4)
    expect(isConsoleEntry(loaded)).toBe(false)
  })
})

describe('finding an entry again after evictions', () => {
  const entries = [said(2), said(5), said(9)]

  it('finds the entry itself while it is retained', () => {
    expect(indexAtOrAfter(entries, 5)).toBe(1)
  })

  it('finds the first entry after it once it was evicted', () => {
    expect(indexAtOrAfter(entries, 3)).toBe(1)
    expect(indexAtOrAfter(entries, 10)).toBe(3)
  })
})
