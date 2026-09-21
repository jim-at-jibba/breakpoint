import { describe, expect, it } from 'vitest'
import { ENTRIES_PER_READ, EventLog, type Entry } from './event-log'

function failure(path: string): Parameters<EventLog['append']>[1] {
  return {
    type: 'project.openFailed',
    path,
    code: 'PROJECT_UNREADABLE',
    message: `${path}: written by a newer Breakpoint`
  }
}

function cursors(entries: readonly Entry[]): number[] {
  return entries.map((entry) => entry.cursor)
}

describe('the cursor', () => {
  it('starts before the first entry, so a reader can ask from zero', () => {
    const log = new EventLog()
    expect(log.cursor).toBe(0)
    expect(log.read()).toEqual({ entries: [], cursor: 0 })
  })

  it('advances by one per entry, whatever the entry is tagged with', () => {
    const log = new EventLog()
    expect(log.append(null, failure('/shop')).cursor).toBe(1)
    expect(log.append('pane-1', failure('/store')).cursor).toBe(2)
    expect(log.append(null, failure('/other')).cursor).toBe(3)
    expect(log.cursor).toBe(3)
  })

  it('returns only what followed the cursor asked from', () => {
    const log = new EventLog()
    for (const path of ['/a', '/b', '/c']) log.append(null, failure(path))

    expect(cursors(log.read({ since: 0 }).entries)).toEqual([1, 2, 3])
    expect(cursors(log.read({ since: 1 }).entries)).toEqual([2, 3])
    expect(cursors(log.read({ since: 3 }).entries)).toEqual([])
  })

  it('orders entries across panes by position, not by the buffer they sit in', () => {
    const log = new EventLog()
    log.append('pane-1', failure('/a'))
    log.append(null, failure('/b'))
    log.append('pane-2', failure('/c'))
    log.append('pane-1', failure('/d'))

    const { entries } = log.read()
    expect(cursors(entries)).toEqual([1, 2, 3, 4])
    expect(entries.map((entry) => entry.pane)).toEqual(['pane-1', null, 'pane-2', 'pane-1'])
  })

  it('reports the position to ask from next, so a caller never has to read the last entry', () => {
    const log = new EventLog()
    log.append(null, failure('/a'))
    log.append(null, failure('/b'))

    expect(log.read({ since: 0 }).cursor).toBe(2)
    expect(log.read({ since: 2 }).cursor).toBe(2)
  })
})

describe('an entry', () => {
  it('carries the pane it came from', () => {
    const log = new EventLog()
    expect(log.append('pane-1', failure('/shop'))).toMatchObject({ pane: 'pane-1' })
  })

  it('is explicitly untagged when the app itself produced it', () => {
    const log = new EventLog()
    expect(log.append(null, failure('/shop'))).toMatchObject({ pane: null })
  })

  it('carries what happened and when', () => {
    const log = new EventLog({ now: () => 1_700_000_000_000 })
    expect(log.append(null, failure('/shop'))).toEqual({
      cursor: 1,
      time: 1_700_000_000_000,
      pane: null,
      type: 'project.openFailed',
      path: '/shop',
      code: 'PROJECT_UNREADABLE',
      message: '/shop: written by a newer Breakpoint'
    })
  })
})

describe('a read too large to carry', () => {
  it('returns as much as one read carries and leaves its cursor where it stopped', () => {
    const log = new EventLog()
    for (let index = 0; index < ENTRIES_PER_READ + 10; index += 1) {
      log.append(null, failure(`/${index}`))
    }

    const first = log.read()
    expect(first.entries).toHaveLength(ENTRIES_PER_READ)
    expect(first.cursor).toBe(ENTRIES_PER_READ)
    expect(first.entries.at(-1)?.cursor).toBe(first.cursor)

    // Asking again from there finishes the log, and the cursor is the head once it fits.
    const rest = log.read({ since: first.cursor })
    expect(cursors(rest.entries)).toEqual(
      Array.from({ length: 10 }, (_, index) => ENTRIES_PER_READ + index + 1)
    )
    expect(rest.cursor).toBe(log.cursor)
    expect(log.read({ since: rest.cursor }).entries).toEqual([])
  })

  it('still says what was evicted, so truncation cannot be read as silence', () => {
    const log = new EventLog({ limit: ENTRIES_PER_READ + 5 })
    for (let index = 0; index < ENTRIES_PER_READ + 10; index += 1) {
      log.append('pane-1', failure(`/${index}`))
    }

    const read = log.read({ since: 0 })
    expect(read.droppedBefore).toBe(6)
    expect(read.entries).toHaveLength(ENTRIES_PER_READ)
    expect(read.entries[0].cursor).toBe(6)
  })
})

describe('eviction', () => {
  it('drops the oldest of a pane past the limit and leaves other panes alone', () => {
    const log = new EventLog({ limit: 3 })
    for (const path of ['/a', '/b', '/c', '/d']) log.append('pane-1', failure(path))
    const untagged = log.append(null, failure('/app'))

    const { entries } = log.read()
    expect(cursors(entries)).toEqual([2, 3, 4, 5])
    expect(entries.at(-1)).toEqual(untagged)
  })

  it('tells a reader whose start was evicted, rather than handing it a short list', () => {
    const log = new EventLog({ limit: 3 })
    for (const path of ['/a', '/b', '/c', '/d', '/e']) log.append('pane-1', failure(path))

    const read = log.read({ since: 1 })
    expect(cursors(read.entries)).toEqual([3, 4, 5])
    // Positions 2 and below are gone; from 3 on this read is everything there was.
    expect(read.droppedBefore).toBe(3)
  })

  it('says nothing to a reader that already had what was evicted', () => {
    const log = new EventLog({ limit: 3 })
    for (const path of ['/a', '/b', '/c', '/d']) log.append('pane-1', failure(path))

    // Position 1 is gone, but a reader asking from 1 had it and missed nothing after it.
    expect(log.read({ since: 1 }).droppedBefore).toBeUndefined()
    expect(log.read({ since: 0 }).droppedBefore).toBe(2)
  })

  it('distinguishes a quiet log from a read whose start was evicted', () => {
    const log = new EventLog({ limit: 3 })
    for (const path of ['/a', '/b', '/c', '/d', '/e']) log.append('pane-1', failure(path))

    // Nothing after the head: no entries and no marker, which is silence.
    expect(log.read({ since: 5 })).toEqual({ entries: [], cursor: 5 })
    // Too slow: the marker says so, and a truncated read is never the empty one above.
    const truncated = log.read({ since: 0 })
    expect(truncated.droppedBefore).toBe(3)
    expect(cursors(truncated.entries)).toEqual([3, 4, 5])
  })

  it('reports eviction from the pane that fell behind furthest', () => {
    const log = new EventLog({ limit: 2 })
    log.append('pane-1', failure('/a'))
    log.append('pane-2', failure('/b'))
    log.append('pane-1', failure('/c'))
    log.append('pane-1', failure('/d'))

    // pane-1 evicted position 1; pane-2 has evicted nothing, and its entry still reads.
    const read = log.read({ since: 0 })
    expect(cursors(read.entries)).toEqual([2, 3, 4])
    expect(read.droppedBefore).toBe(2)
  })

  it('holds ten thousand entries per pane before it evicts anything', () => {
    const log = new EventLog()
    for (let index = 0; index < 10_000; index += 1) log.append('pane-1', failure(`/${index}`))

    // The oldest is still the first thing that happened, and nothing is marked lost.
    const full = log.read({ since: 0 })
    expect(full.entries[0].cursor).toBe(1)
    expect(full.droppedBefore).toBeUndefined()

    log.append('pane-1', failure('/one-too-many'))
    const after = log.read({ since: 0 })
    expect(after.entries[0].cursor).toBe(2)
    expect(after.droppedBefore).toBe(2)
  })
})
