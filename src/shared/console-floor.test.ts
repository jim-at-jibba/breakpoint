import { describe, expect, it } from 'vitest'
import {
  aboveFloor,
  clearConsole,
  DEFAULT_CONSOLE_DISPLAY,
  navigatedConsole,
  raiseFloor,
  readConsoleSettings,
  type ConsoleDisplay
} from './console-floor'

const at = (...cursors: number[]): { cursor: number }[] => cursors.map((cursor) => ({ cursor }))

describe('the display floor', () => {
  it('hides nothing by default, and keeps the log across navigation', () => {
    expect(DEFAULT_CONSOLE_DISPLAY).toEqual({ floor: 0, preserveLog: true })
  })

  it('only ever moves forward', () => {
    expect(raiseFloor(0, 12)).toBe(12)
    expect(raiseFloor(12, 30)).toBe(30)
    // A Clear heard late, behind one that came after it, does not bring entries back.
    expect(raiseFloor(30, 12)).toBe(30)
  })
})

describe('Clear', () => {
  it('raises the floor to the log head', () => {
    expect(clearConsole(DEFAULT_CONSOLE_DISPLAY, 40)).toEqual({ floor: 40, preserveLog: true })
  })

  it('leaves preserve-log as it was', () => {
    const display: ConsoleDisplay = { floor: 5, preserveLog: false }
    expect(clearConsole(display, 9)).toEqual({ floor: 9, preserveLog: false })
  })

  it('answers with the same object when the floor did not move, so nothing is announced', () => {
    const display: ConsoleDisplay = { floor: 40, preserveLog: true }
    expect(clearConsole(display, 40)).toBe(display)
    expect(clearConsole(display, 12)).toBe(display)
  })
})

describe('navigating', () => {
  it('changes nothing while the log is preserved', () => {
    const display: ConsoleDisplay = { floor: 3, preserveLog: true }
    expect(navigatedConsole(display, 50)).toBe(display)
  })

  it('moves the floor to the navigation when it is not, and changes nothing else', () => {
    const display: ConsoleDisplay = { floor: 3, preserveLog: false }
    expect(navigatedConsole(display, 50)).toEqual({ floor: 50, preserveLog: false })
  })

  it('never moves the floor back behind a Clear made after the navigation', () => {
    const display: ConsoleDisplay = { floor: 80, preserveLog: false }
    expect(navigatedConsole(display, 50)).toBe(display)
  })
})

describe('aboveFloor', () => {
  it('shows every entry past the floor, and none at or below it', () => {
    expect(aboveFloor(at(1, 4, 7, 9), 4)).toEqual(at(7, 9))
    expect(aboveFloor(at(1, 4, 7, 9), 5)).toEqual(at(7, 9))
  })

  it('answers with the same array when the floor hides nothing', () => {
    const entries = at(5, 6, 7)
    expect(aboveFloor(entries, 0)).toBe(entries)
    expect(aboveFloor(entries, 4)).toBe(entries)
  })

  it('shows nothing when the floor is at or past the last entry', () => {
    expect(aboveFloor(at(1, 2, 3), 3)).toEqual([])
    expect(aboveFloor(at(1, 2, 3), 99)).toEqual([])
    expect(aboveFloor([], 5)).toEqual([])
  })

  it('shows what arrives after a Clear, whatever the log evicted before it', () => {
    // Positions are ordered but not contiguous: a ring evicts out of the middle.
    expect(aboveFloor(at(2, 30, 31, 45), 31)).toEqual(at(45))
  })
})

describe('readConsoleSettings', () => {
  it('takes the default when the file does not mention the console', () => {
    expect(readConsoleSettings(undefined)).toEqual({ ok: true, console: { preserveLog: true } })
    expect(readConsoleSettings({})).toEqual({ ok: true, console: { preserveLog: true } })
  })

  it('reads preserve-log as stored', () => {
    expect(readConsoleSettings({ preserveLog: false })).toEqual({
      ok: true,
      console: { preserveLog: false }
    })
  })

  it.each([
    ['not an object', 'yes'],
    ['an array', []],
    ['a word', { preserveLog: 'no' }]
  ])('refuses %s', (_name, raw) => {
    expect(readConsoleSettings(raw).ok).toBe(false)
  })
})
