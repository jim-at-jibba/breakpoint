import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ConsoleEntry } from './console-feed'
import {
  anchorAt,
  CONSOLE_ROW_HEIGHT,
  consolePanes,
  consoleRow,
  consoleRowHeight,
  isAtBottom,
  scrollTarget
} from './console-rows'
import { createProject } from './project'

const project = createProject('/repos/shop')
const panes = consolePanes(project.panes)
const [first, second] = project.panes
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

describe('holding the reader’s place', () => {
  const H = CONSOLE_ROW_HEIGHT
  const rows = (...cursors: number[]): ConsoleEntry[] =>
    cursors.map((cursor) => message({ cursor }))

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
    expect(anchor).toEqual({ cursor: 4, offset: 5 })

    expect(scrollTarget(rows(3, 4, 5, 6), anchor, 2 * H)).toBe(H + 5)
  })

  it('holds the first survivor when the entry it held was itself evicted', () => {
    const anchor = anchorAt(rows(1, 2, 3, 4, 5), 5)!

    expect(scrollTarget(rows(3, 4, 5), anchor, 2 * H)).toBe(0)
  })

  it('counts within half a row of the bottom as the bottom', () => {
    expect(isAtBottom(100, 200, 100)).toBe(true)
    expect(isAtBottom(100 - H / 2, 200, 100)).toBe(true)
    expect(isAtBottom(100 - H, 200, 100)).toBe(false)
  })
})
