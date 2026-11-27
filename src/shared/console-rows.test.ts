import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ConsoleEntry } from './console-feed'
import type { ConsoleLevel } from './event-log'
import {
  anchorAt,
  collapseConsole,
  collapseKey,
  CONSOLE_ROW_HEIGHT,
  consoleGroupRow,
  consoleLines,
  consolePanes,
  consoleRow,
  consoleRowHeight,
  filterConsole,
  isAtBottom,
  isFiltering,
  NO_CONSOLE_FILTER,
  isExpanded,
  scrollTarget,
  shownBadges,
  toggleInSet,
  type ConsoleFilter,
  type ConsoleGroup,
  type ConsoleLine
} from './console-rows'
import { createProject } from './project'

const project = createProject('/repos/shop')
const panes = consolePanes(project.panes)
const [first, second, third] = project.panes
const at = new Date(2026, 10, 27, 14, 2, 11, 4).getTime()

type MessageEntry = Extract<ConsoleEntry, { type: 'console.message' }>

function message(overrides: Partial<MessageEntry> = {}): MessageEntry {
  return {
    cursor: 7,
    time: at,
    pane: second.id,
    type: 'console.message',
    level: 'warn',
    source: 'console',
    text: 'careful',
    args: ['careful'],
    url: null,
    location: null,
    stack: [],
    ...overrides
  }
}

describe('mapping an entry to a row', () => {
  it('gives level, pane, time, message and location as columns', () => {
    const row = consoleRow(
      message({
        location: {
          url: 'http://localhost:5173/src/Hero.tsx?t=1',
          line: 31,
          column: 5,
          resolution: 'resolved',
          path: 'src/Hero.tsx'
        }
      }),
      panes
    )

    expect(row).toEqual({
      key: 7,
      level: 'warn',
      pane: { id: second.id, label: second.name, color: 1 },
      time: '14:02:11.004',
      message: 'careful',
      location: 'src/Hero.tsx:31:5',
      locationTitle: 'src/Hero.tsx'
    })
  })

  it('takes the badge colour from the pane’s place in the project, as its header does', () => {
    expect(consoleRow(message({ pane: first.id }), panes).pane.color).toBe(0)
    expect(consoleRow(message({ pane: second.id }), panes).pane.color).toBe(1)
  })

  it('gives a pane no longer in the project no colour, rather than another pane’s', () => {
    expect(consoleRow(message({ pane: 'gone' }), panes).pane).toEqual({
      id: 'gone',
      label: 'gone',
      color: null
    })
  })

  it('draws an exception at error level, with its headline', () => {
    const row = consoleRow(
      {
        cursor: 3,
        time: at,
        pane: first.id,
        type: 'console.exception',
        rejection: false,
        text: 'Uncaught TypeError: nope',
        error: 'TypeError: nope',
        location: {
          url: 'http://localhost:5173/assets/app-4f1c.js',
          line: 1,
          column: 900,
          resolution: 'failed',
          path: null
        },
        stack: []
      },
      panes
    )

    expect(row).toMatchObject({
      level: 'error',
      message: 'Uncaught TypeError: nope',
      location: 'app-4f1c.js:1:900',
      locationTitle: 'http://localhost:5173/assets/app-4f1c.js'
    })
  })

  it('locates a browser message by the resource it is about', () => {
    const row = consoleRow(
      message({ source: 'network', url: 'http://localhost:5173/api/rates?x=1' }),
      panes
    )

    expect(row.location).toBe('rates')
    expect(row.locationTitle).toBe('http://localhost:5173/api/rates?x=1')
  })

  it('folds a message’s line breaks so one line shows its first words', () => {
    expect(consoleRow(message({ text: '\nfirst\n  second\r\nthird' }), panes).message).toBe(
      'first second third'
    )
  })
})

describe('row height', () => {
  it('is one height for every row, however long its message', () => {
    expect(consoleRowHeight()).toBe(CONSOLE_ROW_HEIGHT)
    expect(consoleRow(message({ text: 'x'.repeat(10_000) }), panes).message).not.toContain('\n')
  })

  /** A number because the virtualiser places rows before any stylesheet is read. */
  it.each([
    ['the design prototype', '../../docs/design/breakpoint-prototype/globals.css'],
    ['the renderer', '../renderer/src/index.css']
  ])('agrees with %s on --bp-row-sm', (_where, path) => {
    const css = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    const declared = /--bp-row-sm:\s*([^;]+);/.exec(css)
    expect(declared![1].trim()).toBe(`${CONSOLE_ROW_HEIGHT}px`)
  })
})

describe('the collapse key', () => {
  const located = {
    url: 'http://localhost:5173/src/Cart.tsx?t=1',
    line: 87,
    column: 22,
    resolution: 'resolved' as const,
    path: 'src/Cart.tsx'
  }

  it('is the same for the same message from different panes, at different times', () => {
    expect(collapseKey(message({ pane: first.id, cursor: 1, time: 1 }))).toBe(
      collapseKey(message({ pane: third.id, cursor: 9, time: 2 }))
    )
  })

  it.each<[string, Partial<MessageEntry>]>([
    ['text', { text: 'other' }],
    ['level', { level: 'error' }],
    ['source', { source: 'network' }],
    ['arguments', { args: ['careful', '{width: 390}'] }],
    ['resource', { url: 'http://localhost:5173/api' }],
    ['whether it was located', { location: null }],
    ['line', { location: { ...located, line: 88 } }]
  ])('tells messages apart by %s', (_what, overrides) => {
    const base = message({ location: located })
    expect(collapseKey({ ...base, ...overrides })).not.toBe(collapseKey(base))
  })

  it('locates by the repo path once resolved, so a cache-busting query does not split a row', () => {
    expect(
      collapseKey(
        message({ location: { ...located, url: 'http://localhost:5173/src/Cart.tsx?t=2' } })
      )
    ).toBe(collapseKey(message({ location: located })))
  })

  it('ignores the stack, which expanding the row is for', () => {
    expect(
      collapseKey(
        message({
          stack: [{ functionName: 'f', url: located.url, line: 1, column: 1 } as never]
        })
      )
    ).toBe(collapseKey(message()))
  })

  it('never takes a message for an exception with the same text', () => {
    expect(
      collapseKey({
        cursor: 1,
        time: at,
        pane: first.id,
        type: 'console.exception',
        rejection: false,
        text: 'careful',
        error: null,
        location: null,
        stack: []
      })
    ).not.toBe(collapseKey(message({ text: 'careful' })))
  })
})

describe('collapsing in the view', () => {
  const said = (cursor: number, pane: string, text = 'Uncaught TypeError: total'): MessageEntry =>
    message({ cursor, pane, text, time: at + cursor })
  /** What a row carries, by pane id, which is what collapsing is about: never a count. */
  const carried = (groups: ConsoleGroup[]): string[][] =>
    groups.map((group) => group.entries.map((entry) => entry.pane ?? ''))

  it('is one row carrying three badges for the same message from three panes', () => {
    const groups = collapseConsole([said(1, first.id), said(2, second.id), said(3, third.id)])

    expect(carried(groups)).toEqual([[first.id, second.id, third.id]])
    expect(consoleGroupRow(groups[0], panes).badges.map((badge) => badge.id)).toEqual([
      first.id,
      second.id,
      third.id
    ])
  })

  it('joins a matching entry arriving later to the existing row, across other messages', () => {
    const before = collapseConsole([said(1, first.id), said(2, second.id, 'other')])
    const after = collapseConsole([
      said(1, first.id),
      said(2, second.id, 'other'),
      said(3, third.id)
    ])

    expect(carried(before)).toEqual([[first.id], [second.id]])
    expect(carried(after)).toEqual([[first.id, third.id], [second.id]])
    expect(after.map((group) => group.cursor)).toEqual([1, 2])
  })

  it('gives a pane saying the same thing twice a second row', () => {
    expect(carried(collapseConsole([said(1, first.id), said(2, first.id)]))).toEqual([
      [first.id],
      [first.id]
    ])
  })

  it('reads three panes reloading into one error twice as two rows of three, however they interleave', () => {
    const groups = collapseConsole([
      said(1, first.id),
      said(2, second.id),
      said(3, first.id),
      said(4, third.id),
      said(5, second.id),
      said(6, third.id)
    ])

    expect(carried(groups)).toEqual([
      [first.id, second.id, third.id],
      [first.id, second.id, third.id]
    ])
    expect(groups[1].entries.map((entry) => entry.cursor)).toEqual([3, 5, 6])
  })

  it('collapses over what the window retains, so an evicted entry leaves its row', () => {
    const groups = collapseConsole([said(2, second.id), said(3, third.id)])

    expect(carried(groups)).toEqual([[second.id, third.id]])
    expect(groups[0].cursor).toBe(2)
  })

  it('orders a row’s badges by the panes’ place in the project, not by arrival', () => {
    const [group] = collapseConsole([said(1, third.id), said(2, 'gone'), said(3, first.id)])

    expect(consoleGroupRow(group, panes).badges.map((badge) => badge.id)).toEqual([
      first.id,
      third.id,
      'gone'
    ])
  })

  it('draws two badges and counts the rest, as the prototype does', () => {
    const [group] = collapseConsole([said(1, first.id), said(2, second.id), said(3, third.id)])
    const { shown, more } = shownBadges(consoleGroupRow(group, panes).badges)

    expect(shown.map((badge) => badge.id)).toEqual([first.id, second.id])
    expect(more.map((badge) => badge.id)).toEqual([third.id])
  })
})

describe('expanding a row', () => {
  const said = (cursor: number, pane: string, text = 'same'): MessageEntry =>
    message({ cursor, pane, text, time: at + cursor })
  const groups = collapseConsole([
    said(1, first.id),
    said(2, second.id, 'other'),
    said(3, second.id),
    said(4, third.id)
  ])

  it('is one line per row while nothing is expanded', () => {
    expect(consoleLines(groups, new Set()).map((line) => line.key)).toEqual(['g1', 'g2'])
  })

  it('shows each entry beneath its row, each with its own time and location', () => {
    const lines = consoleLines(groups, new Set([1]))

    expect(lines.map((line) => line.key)).toEqual(['g1', 'e1', 'e3', 'e4', 'g2'])
    const shown = lines.flatMap((line) =>
      line.kind === 'entry' ? [consoleRow(line.entry, panes)] : []
    )
    expect(shown.map((row) => [row.pane.id, row.time])).toEqual([
      [first.id, '14:02:11.005'],
      [second.id, '14:02:11.007'],
      [third.id, '14:02:11.008']
    ])
  })

  it('keeps every line of a row at the row’s cursor, so lines stay in cursor order', () => {
    expect(consoleLines(groups, new Set([1])).map((line) => line.cursor)).toEqual([1, 1, 1, 1, 2])
  })

  it('stays open when the entry it was opened by is evicted', () => {
    const [survivor] = collapseConsole([said(3, second.id), said(4, third.id)])

    expect(isExpanded(survivor, new Set([1, 3]))).toBe(true)
    expect(isExpanded(survivor, new Set([1]))).toBe(false)
  })

  it('never expands a row carrying one entry: there is nothing to separate', () => {
    expect(consoleLines(groups, new Set([2])).map((line) => line.key)).toEqual(['g1', 'g2'])
  })
})

describe('holding the reader’s place', () => {
  const H = CONSOLE_ROW_HEIGHT
  /** One pane saying the same thing again and again: a row per entry. */
  const rows = (...cursors: number[]): ConsoleLine[] =>
    consoleLines(collapseConsole(cursors.map((cursor) => message({ cursor }))), new Set())

  it('follows the newest entry while pinned to the bottom', () => {
    expect(scrollTarget(rows(1, 2, 3, 4, 5), null, 2 * H)).toBe(3 * H)
    expect(scrollTarget(rows(1), null, 2 * H)).toBe(0)
  })

  it('does not move while entries arrive below a reader who scrolled up', () => {
    const before = rows(1, 2, 3, 4, 5)
    const anchor = anchorAt(before, H + 5)!

    expect(scrollTarget(before.concat(rows(6, 7, 8)), anchor, 2 * H)).toBe(H + 5)
  })

  it('moves up by exactly the rows evicted above, so the same entry stays in view', () => {
    const anchor = anchorAt(rows(1, 2, 3, 4, 5), 3 * H + 5)!
    expect(anchor).toEqual({ key: 'g4', cursor: 4, offset: 5 })

    expect(scrollTarget(rows(3, 4, 5, 6), anchor, 2 * H)).toBe(H + 5)
  })

  it('holds the first survivor when the entry it held was itself evicted', () => {
    const anchor = anchorAt(rows(1, 2, 3, 4, 5), 5)!

    expect(scrollTarget(rows(3, 4, 5), anchor, 2 * H)).toBe(0)
  })

  it('holds a line inside an expanded row while rows arrive and evict around it', () => {
    const same = (cursor: number, pane: string): MessageEntry =>
      message({ cursor, pane, text: 'same' })
    const lines = (entries: MessageEntry[]): ConsoleLine[] =>
      consoleLines(collapseConsole([message({ cursor: 1 }), ...entries]), new Set([2]))
    const before = lines([same(2, first.id), same(3, second.id), same(4, third.id)])
    const anchor = anchorAt(before, 3 * H + 5)!
    expect(anchor).toMatchObject({ key: 'e3', cursor: 2 })

    const after = consoleLines(
      collapseConsole([
        same(2, first.id),
        same(3, second.id),
        same(4, third.id),
        message({ cursor: 9 })
      ]),
      new Set([2])
    )
    expect(scrollTarget(after, anchor, 2 * H)).toBe(2 * H + 5)
  })

  it('counts within half a row of the bottom as the bottom', () => {
    expect(isAtBottom(100, 200, 100)).toBe(true)
    expect(isAtBottom(100 - H / 2, 200, 100)).toBe(true)
    expect(isAtBottom(100 - H, 200, 100)).toBe(false)
  })
})

describe('filtering by pane, level and text', () => {
  const entries: ConsoleEntry[] = [
    message({ cursor: 1, pane: first.id, level: 'error', text: 'Failed to fetch /api/rates' }),
    message({ cursor: 2, pane: second.id, level: 'error', text: 'Failed to fetch /api/rates' }),
    message({ cursor: 3, pane: third.id, level: 'error', text: 'Failed to fetch /api/rates' }),
    message({ cursor: 4, pane: first.id, level: 'log', text: 'ready' }),
    message({ cursor: 5, pane: second.id, level: 'warn', text: 'Slow image' }),
    {
      cursor: 6,
      time: at,
      pane: third.id,
      type: 'console.exception',
      rejection: false,
      text: 'Uncaught TypeError: menu is null',
      error: 'TypeError: menu is null',
      location: null,
      stack: []
    }
  ]
  const cursors = (filter: Partial<ConsoleFilter>): number[] =>
    filterConsole(entries, { ...NO_CONSOLE_FILTER, ...filter }).map((entry) => entry.cursor)

  it('shows every entry with no filter, as the same array', () => {
    expect(isFiltering(NO_CONSOLE_FILTER)).toBe(false)
    expect(filterConsole(entries, NO_CONSOLE_FILTER)).toBe(entries)
  })

  it('narrows by pane on its own', () => {
    expect(cursors({ panes: new Set([first.id]) })).toEqual([1, 4])
  })

  it('narrows by level on its own, counting an exception as an error', () => {
    expect(cursors({ levels: new Set(['error']) })).toEqual([1, 2, 3, 6])
    expect(cursors({ levels: new Set(['warn', 'log']) })).toEqual([4, 5])
  })

  it('narrows by text on its own, ignoring case and surrounding space', () => {
    expect(cursors({ text: '  FAILED to ' })).toEqual([1, 2, 3])
    expect(cursors({ text: 'menu' })).toEqual([6])
  })

  it('matches text anywhere in the message, not only the line a row shows', () => {
    const long = [message({ cursor: 9, text: 'first line\nsecond line' })]
    expect(filterConsole(long, { ...NO_CONSOLE_FILTER, text: 'second' })).toHaveLength(1)
  })

  it('combines the three, each narrowing what the others leave', () => {
    expect(cursors({ panes: new Set([third.id]), levels: new Set(['error']) })).toEqual([3, 6])
    expect(
      cursors({ panes: new Set([third.id]), levels: new Set(['error']), text: 'fetch' })
    ).toEqual([3])
    expect(cursors({ panes: new Set([first.id]), levels: new Set(['warn']) })).toEqual([])
  })

  it('treats blank text as no filter', () => {
    expect(isFiltering({ ...NO_CONSOLE_FILTER, text: '   ' })).toBe(false)
    expect(cursors({ text: '   ' })).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('lets a pane filter hide a pane no longer in the project, and no filter show it', () => {
    const gone = [message({ cursor: 1, pane: 'gone' })]
    expect(filterConsole(gone, { ...NO_CONSOLE_FILTER, panes: new Set([first.id]) })).toEqual([])
    expect(filterConsole(gone, NO_CONSOLE_FILTER)).toEqual(gone)
  })

  it('gives a collapsed row only the badges of panes still in view', () => {
    const filter = { ...NO_CONSOLE_FILTER, panes: new Set([second.id, third.id]) }
    const [row] = collapseConsole(filterConsole(entries, filter)).map((group) =>
      consoleGroupRow(group, panes)
    )

    expect(row.badges.map((badge) => badge.id)).toEqual([second.id, third.id])
    expect(row.key).toBe(2)
  })

  it('brings back every retained entry, collapsed as before, once cleared', () => {
    const narrowed = { panes: new Set([first.id]), levels: new Set<ConsoleLevel>(['log']), text: 'r' }
    expect(cursors(narrowed)).toEqual([4])
    expect(collapseConsole(filterConsole(entries, NO_CONSOLE_FILTER))).toEqual(
      collapseConsole(entries)
    )
  })
})

describe('toggling one value of a filter', () => {
  const all = ['a', 'b', 'c']

  it('takes one value from everything, leaving the rest', () => {
    expect(toggleInSet(null, 'b', all)).toEqual(new Set(['a', 'c']))
  })

  it('adds a value back, and is everything again once all are back', () => {
    expect(toggleInSet(new Set(['a']), 'c', all)).toEqual(new Set(['a', 'c']))
    expect(toggleInSet(new Set(['a', 'c']), 'b', all)).toBeNull()
  })

  it('can take away the last value, which shows nothing rather than everything', () => {
    expect(toggleInSet(new Set(['a']), 'a', all)).toEqual(new Set())
  })
})
