import type { EmulationCapability, EmulationChanges } from './emulation'
import type { Size } from './panes'
import {
  jsonByteLength,
  MAX_FRAME_BYTES,
  MAX_REQUEST_ID_BYTES,
  type WireErrorCode
} from './protocol'

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
 * No I/O or Electron; the clock can be supplied by the caller. The main
 * process owns the one instance; the CLI and the renderer import the types.
 */

/** PRD 8.6. The app's own entries are a ring of the same size, keyed by no pane. */
export const ENTRIES_PER_PANE = 10_000

export const ENTRIES_PER_READ = 1_000
// Reserve the largest accepted id plus the success envelope around the payload.
export const MAX_LOG_READ_BYTES = MAX_FRAME_BYTES - MAX_REQUEST_ID_BYTES - 64
export const MAX_ENTRY_TEXT_BYTES = 16 * 1024

/**
 * What an entry says. One kind per producer, and a kind arrives with the ticket that
 * produces it — navigation and emulation are the next ones, and the console's kinds are
 * Phase 2.
 */
export type EntryBody = ProjectEntryBody | PaneEntryBody

/** The app's own: untagged. */
export type ProjectEntryBody = {
  readonly type: 'project.openFailed'
  /** As the caller asked for it: canonicalising the path is one of the things that fails. */
  readonly path: string
  /** The same stable code the route call failed with, so both surfaces branch alike. */
  readonly code: WireErrorCode
  readonly message: string
}

/**
 * A pane's lifecycle, tagged with the pane. The log's first pane-tagged producer: a
 * guest created for the pane, its attachment made or refused, its page loaded or not,
 * its host-side geometry check failing and recovering, and the guest going away.
 */
export type PaneEntryBody =
  /** The pane was declared: added to the project, from a preset or at a size given. */
  | {
      readonly type: 'pane.added'
      readonly width: number
      readonly height: number
      /** The preset it was resolved from, or `null` for a size the developer typed. */
      readonly preset: string | null
    }
  /** The pane was taken out of the project. Its guest going is `pane.destroyed`. */
  | { readonly type: 'pane.removed' }
  /** The pane's declared size changed, by exact dimensions or by rotation. */
  | { readonly type: 'pane.resized'; readonly width: number; readonly height: number }
  | { readonly type: 'pane.created'; readonly url: string }
  | { readonly type: 'pane.attached'; readonly attempt: number }
  | {
      readonly type: 'pane.attachFailed'
      readonly attempt: number
      /** Whether one more attempt follows the next load. The second failure is final. */
      readonly retrying: boolean
      readonly message: string
    }
  | { readonly type: 'pane.loaded'; readonly url: string }
  | {
      readonly type: 'pane.loadFailed'
      readonly url: string
      /** Chromium's net error code, negative, as `did-fail-load` reports it. */
      readonly code: number
      readonly message: string
    }
  | {
      readonly type: 'pane.geometryMismatch'
      /** Screen pixels: declared size times the canvas zoom. */
      readonly expected: Readonly<Size>
      /** Screen pixels: the pane element's own rendered box. */
      readonly measured: Readonly<Size>
      readonly message: string
    }
  | { readonly type: 'pane.geometryMatched' }
  /** The pane's declared emulation was changed through `panes.setEmulation`: the new values. */
  | { readonly type: 'pane.emulationChanged'; readonly changes: Readonly<EmulationChanges> }
  /**
   * One override was refused, so that capability is not in force. Written when it starts
   * failing or fails differently, not on every reapply that fails the same way.
   */
  | {
      readonly type: 'pane.emulationFailed'
      readonly capability: EmulationCapability
      readonly message: string
    }
  | { readonly type: 'pane.emulationRecovered'; readonly capability: EmulationCapability }
  | { readonly type: 'pane.destroyed' }

type TruncatedField = 'path' | 'message' | 'url'

const TEXT_FIELDS: readonly TruncatedField[] = ['path', 'url', 'message']

/**
 * One record in the log. `pane` is the pane it came from, or `null` when the app itself
 * produced it — a required field, because "which pane" is never a question an entry
 * leaves open.
 */
export type EntryMeta = {
  readonly cursor: number
  /** Milliseconds since the epoch, taken when the entry was appended. */
  readonly time: number
  readonly pane: string | null
  readonly truncated?: readonly TruncatedField[]
}

export type Entry = EntryMeta & EntryBody

/** An entry of one kind, for a reader that has already checked `type`. */
export type EntryOf<T extends EntryBody['type']> = EntryMeta & Extract<EntryBody, { type: T }>

export interface LogRead {
  readonly entries: readonly Entry[]
  /**
   * The position to ask from next, whether or not anything was read: the log's head,
   * or the last entry returned when there was more than one read could carry. A reader
   * that asks again from here and gets nothing has caught up.
   */
  readonly cursor: number
  /**
   * Present only when entries after the position asked from had already been evicted.
   * From this position on the read is everything there was; below it, entries may be
   * missing. Absent means the read is complete, so an empty read with no marker is a
   * quiet log rather than a reader that fell behind.
   */
  readonly droppedBefore?: number
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
  append<B extends EntryBody>(pane: string | null, body: B): EntryOf<B['type']> {
    this.position += 1
    const entry = Object.freeze({
      cursor: this.position,
      time: this.now(),
      pane,
      ...copyBody(body)
    }) as EntryOf<B['type']>

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

    const dropped = since < evictedThrough ? { droppedBefore: evictedThrough + 1 } : {}
    const carried: Entry[] = []
    let bytes = jsonByteLength({ entries: [], cursor: this.position, ...dropped })
    for (const entry of entries) {
      if (carried.length === ENTRIES_PER_READ) break
      const readable = entryForRead(entry)
      const addedBytes = jsonByteLength(readable) + (carried.length > 0 ? 1 : 0)
      if (carried.length === 0 && bytes + addedBytes > MAX_LOG_READ_BYTES) {
        throw new RangeError('entry metadata exceeds the log read byte limit')
      }
      if (bytes + addedBytes > MAX_LOG_READ_BYTES) break
      carried.push(readable)
      bytes += addedBytes
    }
    const last = carried.at(-1)
    const cursor = carried.length < entries.length && last ? last.cursor : this.position

    return Object.freeze({ entries: Object.freeze(carried), cursor, ...dropped })
  }

  private ringFor(pane: string | null): Ring {
    const existing = this.rings.get(pane)
    if (existing) return existing
    const ring: Ring = { entries: [], evictedThrough: 0 }
    this.rings.set(pane, ring)
    return ring
  }
}

/**
 * The body's own fields and nothing else, frozen. `append` is handed entries as bodies
 * too, and their cursor, time and truncation marker must not ride along.
 */
function copyBody(body: EntryBody): EntryBody {
  switch (body.type) {
    case 'project.openFailed':
      return { type: body.type, path: body.path, code: body.code, message: body.message }
    case 'pane.added':
      return { type: body.type, width: body.width, height: body.height, preset: body.preset }
    case 'pane.resized':
      return { type: body.type, width: body.width, height: body.height }
    case 'pane.created':
    case 'pane.loaded':
      return { type: body.type, url: body.url }
    case 'pane.attached':
      return { type: body.type, attempt: body.attempt }
    case 'pane.attachFailed':
      return {
        type: body.type,
        attempt: body.attempt,
        retrying: body.retrying,
        message: body.message
      }
    case 'pane.loadFailed':
      return { type: body.type, url: body.url, code: body.code, message: body.message }
    case 'pane.geometryMismatch':
      return {
        type: body.type,
        expected: Object.freeze({ width: body.expected.width, height: body.expected.height }),
        measured: Object.freeze({ width: body.measured.width, height: body.measured.height }),
        message: body.message
      }
    case 'pane.emulationChanged':
      return { type: body.type, changes: Object.freeze({ ...body.changes }) }
    case 'pane.emulationFailed':
      return { type: body.type, capability: body.capability, message: body.message }
    case 'pane.emulationRecovered':
      return { type: body.type, capability: body.capability }
    case 'pane.geometryMatched':
    case 'pane.removed':
    case 'pane.destroyed':
      return { type: body.type }
  }
}

function entryForRead(entry: Entry): Entry {
  const shortened: Partial<Record<TruncatedField, string>> = {}
  const truncated: TruncatedField[] = []
  const fields = entry as Partial<Record<TruncatedField, unknown>>
  for (const field of TEXT_FIELDS) {
    const text = fields[field]
    if (typeof text !== 'string') continue
    const short = truncateText(text)
    if (short === text) continue
    shortened[field] = short
    truncated.push(field)
  }
  if (truncated.length === 0) return entry
  return Object.freeze({ ...entry, ...shortened, truncated: Object.freeze(truncated) })
}

function truncateText(text: string): string {
  if (jsonByteLength(text) <= MAX_ENTRY_TEXT_BYTES) return text
  let start = 0
  let end = Math.min(text.length, MAX_ENTRY_TEXT_BYTES)
  while (start < end) {
    const middle = Math.ceil((start + end) / 2)
    if (jsonByteLength(text.slice(0, middle)) <= MAX_ENTRY_TEXT_BYTES) start = middle
    else end = middle - 1
  }
  // Do not split a supplementary Unicode character at the truncation boundary.
  const last = text.charCodeAt(start - 1)
  if (last >= 0xd800 && last <= 0xdbff) start -= 1
  return text.slice(0, start)
}
