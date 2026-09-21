import type { WireErrorCode } from './protocol'

/**
 * The event log: one append-only record of everything Breakpoint observes, with one
 * monotonic cursor ([ADR-0006]).
 *
 * Entries are ring-buffered per pane, so a noisy pane cannot push every other pane's
 * history out of the log. That evicts positions out of the middle of a globally ordered
 * sequence, which is the tension the ADR settles: cursor positions are ordered but not
 * contiguous, and a read whose start was evicted says so rather than coming back short
 * and letting the reader conclude the app was quiet.
 *
 * Pure: no clock of its own unless it is given one, no I/O, no Electron. The main
 * process owns the one instance; the CLI and the renderer import the types.
 */

/** PRD 8.6. The app's own entries are a ring of the same size, keyed by no pane. */
export const ENTRIES_PER_PANE = 10_000

/**
 * Entries one read will return. PRD 8.6 asks for truncation at read time, and the
 * socket makes it compulsory: a response is one line of at most `MAX_FRAME_BYTES`, so
 * an untruncated read of a full log could not be delivered at all. A truncated read
 * says so by where it leaves its cursor, and the reader asks again from there.
 */
export const ENTRIES_PER_READ = 1_000

/**
 * What an entry says. One kind per producer, and a kind arrives with the ticket that
 * produces it — pane lifecycle, navigation and emulation are the next ones, and the
 * console's kinds are Phase 2.
 */
export type EntryBody = {
  type: 'project.openFailed'
  /** As the caller asked for it: canonicalising the path is one of the things that fails. */
  path: string
  /** The same stable code the route call failed with, so both surfaces branch alike. */
  code: WireErrorCode
  message: string
}

/**
 * One record in the log. `pane` is the pane it came from, or `null` when the app itself
 * produced it — a required field, because "which pane" is never a question an entry
 * leaves open.
 */
export type Entry = {
  cursor: number
  /** Milliseconds since the epoch, taken when the entry was appended. */
  time: number
  pane: string | null
} & EntryBody

export interface LogRead {
  entries: Entry[]
  /**
   * The position to ask from next, whether or not anything was read: the log's head,
   * or the last entry returned when there was more than one read could carry. A reader
   * that asks again from here and gets nothing has caught up.
   */
  cursor: number
  /**
   * Present only when entries after the position asked from had already been evicted.
   * From this position on the read is everything there was; below it, entries may be
   * missing. Absent means the read is complete, so an empty read with no marker is a
   * quiet log rather than a reader that fell behind.
   */
  droppedBefore?: number
}

/**
 * Whether a value is a position on the cursor. Both surfaces ask this rather than
 * each writing the rule out: the route checks what JSON carried, and the command checks
 * what was typed, and they must agree about what they are refusing.
 */
export function isCursorPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export interface ReadParams {
  /** Everything strictly after this position. Zero, the default, is the whole log. */
  since?: number
}

export interface EventLogOptions {
  /** Entries per pane before the oldest is evicted. Lowered in tests. */
  limit?: number
  now?: () => number
}

/**
 * One pane's ring, or the app's. A pane's entries outlive the pane: the log is a record
 * of what happened, and removing a pane does not unhappen what it said.
 */
interface Ring {
  entries: Entry[]
  /** The highest position evicted from this ring; 0 while it has lost nothing. */
  evictedThrough: number
}

export class EventLog {
  private position = 0
  /** One ring per pane, plus one keyed by `null` for the app's own entries. */
  private readonly rings = new Map<string | null, Ring>()
  private readonly limit: number
  private readonly now: () => number

  constructor({ limit = ENTRIES_PER_PANE, now = () => Date.now() }: EventLogOptions = {}) {
    this.limit = limit
    this.now = now
  }

  /** The position of the last entry appended; what a snapshot taken now carries. */
  get cursor(): number {
    return this.position
  }

  /** `pane` is positional and required: an untagged entry is a decision, not an omission. */
  append(pane: string | null, body: EntryBody): Entry {
    this.position += 1
    const entry: Entry = { cursor: this.position, time: this.now(), pane, ...body }

    const ring = this.ringFor(pane)
    ring.entries.push(entry)
    if (ring.entries.length > this.limit) {
      const [evicted] = ring.entries.splice(0, 1)
      ring.evictedThrough = evicted.cursor
    }

    return entry
  }

  read({ since = 0 }: ReadParams = {}): LogRead {
    const entries: Entry[] = []
    let evictedThrough = 0

    for (const ring of this.rings.values()) {
      evictedThrough = Math.max(evictedThrough, ring.evictedThrough)
      for (const entry of ring.entries) {
        if (entry.cursor > since) entries.push(entry)
      }
    }
    entries.sort((left, right) => left.cursor - right.cursor)

    // Truncated from the far end, so what is returned still starts where the reader
    // asked and the rest is the next read rather than a hole.
    const carried = entries.slice(0, ENTRIES_PER_READ)
    const last = carried.at(-1)
    const cursor = carried.length < entries.length && last ? last.cursor : this.position

    const read: LogRead = { entries: carried, cursor }
    // Everything the reader asked for is intact from one past the last eviction onwards.
    if (since < evictedThrough) read.droppedBefore = evictedThrough + 1
    return read
  }

  private ringFor(pane: string | null): Ring {
    const existing = this.rings.get(pane)
    if (existing) return existing
    const ring: Ring = { entries: [], evictedThrough: 0 }
    this.rings.set(pane, ring)
    return ring
  }
}
