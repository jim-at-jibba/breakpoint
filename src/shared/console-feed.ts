import type { Entry, EntryOf, LogRead } from './event-log'

/**
 * The console's own push channel, main to renderer, and the fold the window keeps its copy
 * of the log's console entries with.
 *
 * Not snapshot patches ([#6], [#49]): the snapshot is kept current by numbered patches at
 * frame cadence, and one patch per entry would spin its revision at the rate a page logs.
 * Entries ride here instead, batched per frame, and a batch that goes missing costs the
 * console a refetch through `log.read` rather than costing the window its snapshot.
 *
 * A batch is numbered by the log's own cursor, which every append moves by exactly one, so
 * a gap is visible even though the batch carries only console entries: a batch says the
 * position it follows on from, and a reader that holds less than that missed one.
 */

export type ConsoleEntry = EntryOf<'console.message'> | EntryOf<'console.exception'>

export function isConsoleEntry(entry: Entry): entry is ConsoleEntry {
  return entry.type === 'console.message' || entry.type === 'console.exception'
}

/**
 * A pane's ring evicted its console entries up to and including `through`. Per pane,
 * because the log rings per pane: a noisy pane's evictions never touch a quiet one's.
 * `null` is the app's own ring, which has no console entries but is still a ring.
 */
export interface ConsoleEviction {
  readonly pane: string | null
  readonly through: number
}

export interface ConsoleBatch {
  /**
   * The log position this batch follows on from: everything up to here was in an earlier
   * batch or had nothing for the console. A reader holding less than this missed a batch.
   */
  readonly after: number
  /** The log position this batch brings a reader up to. */
  readonly cursor: number
  /** The console entries appended in between, in cursor order, as a read carries them. */
  readonly entries: readonly ConsoleEntry[]
  readonly evicted: readonly ConsoleEviction[]
}

/**
 * The window's copy of the log's console entries: every one the log retains, in cursor
 * order, and the log position it is current to.
 */
export interface ConsoleHistory {
  readonly cursor: number
  readonly entries: readonly ConsoleEntry[]
}

export const EMPTY_CONSOLE_HISTORY: ConsoleHistory = Object.freeze({
  cursor: 0,
  entries: Object.freeze([])
})

export type ConsoleFold = { gap: false; history: ConsoleHistory } | { gap: true }

/**
 * A batch folded into the history. Its evictions always apply: an entry the log has let go
 * of is gone whether or not the reader had already heard of it, so a batch that arrives
 * late, behind a refetch that overtook it, still removes what it removes, and they apply
 * after its entries, which a busy pane can evict within the frame that appended them. Its
 * entries apply only past the history's cursor, so overlap is never a duplicate.
 */
export function foldConsoleBatch(history: ConsoleHistory, batch: ConsoleBatch): ConsoleFold {
  if (batch.after > history.cursor) return { gap: true }
  const fresh = batch.entries.filter((entry) => entry.cursor > history.cursor)
  // Evicted after appending: a batch can carry an entry and the eviction of that entry.
  const appended = fresh.length === 0 ? history.entries : history.entries.concat(fresh)
  const kept = evict(appended, batch.evicted)
  if (kept === history.entries && batch.cursor <= history.cursor) return { gap: false, history }
  return { gap: false, history: { cursor: Math.max(history.cursor, batch.cursor), entries: kept } }
}

/** One page of a refetch through `log.read`, folded in. Everything that is not console is not kept. */
export function foldConsoleRead(history: ConsoleHistory, read: LogRead): ConsoleHistory {
  const fresh = read.entries.filter(
    (entry): entry is ConsoleEntry => entry.cursor > history.cursor && isConsoleEntry(entry)
  )
  return {
    cursor: Math.max(history.cursor, read.cursor),
    entries: fresh.length === 0 ? history.entries : history.entries.concat(fresh)
  }
}

/**
 * The entries a pane's ring has let go of, removed. The same array back when nothing was
 * removed, so a batch that only appends costs no scan.
 */
function evict(
  entries: readonly ConsoleEntry[],
  evicted: readonly ConsoleEviction[]
): readonly ConsoleEntry[] {
  if (evicted.length === 0) return entries
  const through = new Map(evicted.map(({ pane, through }) => [pane, through]))
  const kept = entries.filter((entry) => entry.cursor > (through.get(entry.pane) ?? 0))
  return kept.length === entries.length ? entries : kept
}

/**
 * The index of the first entry at or after `cursor`, which is where a reader scrolled to
 * that entry should be now. Entries are in cursor order, so a binary search; an entry that
 * was evicted is answered with the first one that survived it.
 */
export function indexAtOrAfter(
  entries: readonly { readonly cursor: number }[],
  cursor: number
): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (entries[middle].cursor < cursor) low = middle + 1
    else high = middle
  }
  return low
}
