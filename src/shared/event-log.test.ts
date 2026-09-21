import { describe, expect, it } from 'vitest'
import {
  ENTRIES_PER_READ,
  EventLog,
  MAX_ENTRY_TEXT_BYTES,
  type Entry,
  type EntryOf,
  type ProjectEntryBody
} from './event-log'
import { encodeLine, LineBuffer, MAX_FRAME_BYTES, MAX_REQUEST_ID_BYTES, success } from './protocol'

function failure(path: string): ProjectEntryBody {
  return {
    type: 'project.openFailed',
    path,
    code: 'PROJECT_UNREADABLE',
    message: `${path}: written by a newer Breakpoint`
  }
}

/** The failures these tests append, read back as what they are. */
function asFailure(entry: Entry | undefined): EntryOf<'project.openFailed'> {
  if (entry?.type !== 'project.openFailed') throw new Error(`not a failure: ${entry?.type}`)
  return entry
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
  it('assigns fresh metadata even when an existing entry supplies the body', () => {
    const log = new EventLog()
    const first = log.append('pane-1', failure('/shop'))
    const second = log.append('pane-2', first)
    expect(second).toMatchObject({ cursor: 2, pane: 'pane-2', path: '/shop' })
    expect(log.cursor).toBe(2)
  })

  it('cannot be rewritten through append or read results', () => {
    const log = new EventLog()
    const appended = log.append(null, failure('/shop'))
    expect(Reflect.set(appended, 'cursor', 9000)).toBe(false)
    const read = log.read()
    expect(Reflect.set(asFailure(read.entries[0]), 'message', 'rewritten')).toBe(false)
    expect(Reflect.set(read.entries, '0', appended)).toBe(false)
    expect(Reflect.set(read, 'cursor', 9000)).toBe(false)
    expect(log.read()).toEqual({ entries: [appended], cursor: 1 })
    expect(appended.message).toBe('/shop: written by a newer Breakpoint')
  })

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
  it('keeps text at the encoded limit intact and marks only fields that exceed it', () => {
    const log = new EventLog()
    const path = 'x'.repeat(MAX_ENTRY_TEXT_BYTES - 2)
    log.append(null, { ...failure(path), message: `${path}x` })
    const entry = asFailure(log.read().entries[0])
    expect(entry.path).toBe(path)
    expect(entry.message).toBe(path)
    expect(entry.truncated).toEqual(['message'])
  })

  it.each(['é', '\n', '😀'])(
    'pages by serialized bytes including %j and the envelope',
    (text: string) => {
      const log = new EventLog({ limit: 150 })
      for (let index = 0; index < 151; index += 1) {
        log.append(null, failure(`/${index}/${text.repeat(3000)}`))
      }
      const id = 'x'.repeat(MAX_REQUEST_ID_BYTES - 2)
      const seen: number[] = []
      let since = 0
      let pages = 0
      while (true) {
        const read = log.read({ since })
        const frame = encodeLine(success(id, read))
        expect(Buffer.byteLength(frame) - 1).toBeLessThanOrEqual(MAX_FRAME_BYTES)
        expect(new LineBuffer().push(frame)).toHaveLength(1)
        if (since === 0) expect(read.droppedBefore).toBe(2)
        else expect(read.droppedBefore).toBeUndefined()
        if (read.entries.length === 0) break
        expect(read.cursor).toBeGreaterThan(since)
        expect(read.entries.at(-1)?.cursor).toBe(read.cursor)
        seen.push(...cursors(read.entries))
        since = read.cursor
        pages += 1
      }
      expect(pages).toBeGreaterThan(1)
      expect(seen).toEqual(Array.from({ length: 150 }, (_, index: number) => index + 2))
    }
  )

  it.each(['x', '\u0000', '😀'])(
    'marks oversized text with %j without changing stored history',
    (text: string) => {
      const log = new EventLog()
      const original = log.append(null, failure(`/${text.repeat(600_000)}`))
      const read = log.read()
      const entry = asFailure(read.entries[0])
      expect(entry.truncated).toEqual(['path', 'message'])
      expect(Buffer.byteLength(JSON.stringify(entry.path))).toBeLessThanOrEqual(
        MAX_ENTRY_TEXT_BYTES
      )
      expect(Buffer.byteLength(JSON.stringify(entry.message))).toBeLessThanOrEqual(
        MAX_ENTRY_TEXT_BYTES
      )
      expect(original.path.startsWith(entry.path)).toBe(true)
      expect(original.message.startsWith(entry.message)).toBe(true)
      expect(entry.path).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(original.path).toBe(`/${text.repeat(600_000)}`)
      expect(original.truncated).toBeUndefined()
      expect(Reflect.set(entry, 'message', 'rewritten')).toBe(false)
      expect(Object.isFrozen(entry.truncated)).toBe(true)
      expect(read.cursor).toBe(1)
      expect(new LineBuffer().push(encodeLine(success('1', read)))).toHaveLength(1)
      expect(log.read({ since: read.cursor })).toEqual({ entries: [], cursor: 1 })
    }
  )

  it('does not silently skip an entry whose pane identity cannot fit', () => {
    const log = new EventLog()
    log.append('x'.repeat(MAX_FRAME_BYTES), failure('/shop'))
    expect(() => log.read()).toThrow('entry metadata exceeds the log read byte limit')
    expect(log.cursor).toBe(1)
  })

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

describe('pane lifecycle entries', () => {
  it('carry the pane they came from and what happened to it', () => {
    const log = new EventLog({ now: () => 1_700_000_000_000 })
    expect(log.append('pane-1', { type: 'pane.loaded', url: 'http://127.0.0.1:5173/' })).toEqual({
      cursor: 1,
      time: 1_700_000_000_000,
      pane: 'pane-1',
      type: 'pane.loaded',
      url: 'http://127.0.0.1:5173/'
    })
    expect(
      log.append('pane-1', {
        type: 'pane.attachFailed',
        attempt: 1,
        retrying: true,
        message: 'Debugger is already attached to the target'
      })
    ).toMatchObject({ cursor: 2, pane: 'pane-1', attempt: 1, retrying: true })
  })

  it('copy only their own fields when another entry supplies the body', () => {
    const log = new EventLog()
    const long = log.append('pane-1', { type: 'pane.loaded', url: `/${'x'.repeat(600_000)}` })
    const [read] = log.read().entries
    const again = log.append('pane-2', read)
    expect(again).not.toHaveProperty('truncated')
    expect(again).toMatchObject({ cursor: 2, pane: 'pane-2', type: 'pane.loaded' })
    expect(Object.keys(long).sort()).toEqual(['cursor', 'pane', 'time', 'type', 'url'])
  })

  it('shorten a long URL on read and say so', () => {
    const log = new EventLog()
    log.append('pane-1', {
      type: 'pane.loadFailed',
      url: `http://127.0.0.1/${'x'.repeat(600_000)}`,
      code: -102,
      message: 'ERR_CONNECTION_REFUSED'
    })
    const [entry] = log.read().entries
    expect(entry.truncated).toEqual(['url'])
    expect(entry).toMatchObject({ code: -102, message: 'ERR_CONNECTION_REFUSED' })
  })

  it('keep a geometry mismatch immutable down to the sizes it reports', () => {
    const log = new EventLog()
    const entry = log.append('pane-1', {
      type: 'pane.geometryMismatch',
      expected: { width: 390, height: 844 },
      measured: { width: 390, height: 150 },
      message: 'drawn 390×150, declared 390×844 at this zoom'
    })
    expect(entry.type === 'pane.geometryMismatch' && Object.isFrozen(entry.measured)).toBe(true)
  })
})
