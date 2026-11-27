import { indexAtOrAfter, type ConsoleEntry } from './console-feed'
import type { ConsoleLevel, SourceLocation } from './event-log'
import type { Pane } from './project'

/**
 * What one console row shows, worked out from an entry ([ADR-0024]): level, pane, time,
 * message and location as columns, the message one line. Pure, so the mapping is tested
 * without a window, and cheap, because the view maps only the rows it draws.
 */

/**
 * The height of every row, in CSS pixels: the prototype's `--bp-row-sm`, "console row".
 * A number here because the virtualiser places rows by arithmetic before any stylesheet
 * is read; `console-rows.test.ts` holds it to both stylesheets.
 */
export const CONSOLE_ROW_HEIGHT = 22

/**
 * The height a row is drawn at. The same for every row, whatever its message says or how
 * long it is: the message is clamped to one line, so no row is ever measured, and placing
 * the ten-thousandth row costs a multiplication ([ADR-0024]).
 */
export function consoleRowHeight(): number {
  return CONSOLE_ROW_HEIGHT
}

/**
 * The pane a row came from, as its badge draws it. `color` is the pane's position in the
 * palette — the same one its header's tab uses — or `null` for a pane no longer in the
 * project: its entries outlive it, but a colour now belongs to whichever pane holds it.
 */
export interface ConsolePaneBadge {
  id: string
  label: string
  color: number | null
}

export interface ConsoleRow {
  /** The entry's cursor: unique, and stable while the row is retained. */
  key: number
  level: ConsoleLevel
  pane: ConsolePaneBadge
  /** Local wall-clock time, to the millisecond: `14:02:11.004`. */
  time: string
  /** One line's worth: what the entry says, with its line breaks folded to spaces. */
  message: string
  /** Where it happened, as `file:line:column`, or `null` when nothing says. */
  location: string | null
  /** The full location, for a tooltip: the repo path or the script's URL. */
  locationTitle: string | null
}

/** The panes of the open project, by id, as a row needs them. */
export type ConsolePanes = ReadonlyMap<string, { name: string; index: number }>

export function consolePanes(panes: readonly Pane[]): ConsolePanes {
  return new Map(panes.map((pane, index) => [pane.id, { name: pane.name, index }]))
}

export function consoleRow(entry: ConsoleEntry, panes: ConsolePanes): ConsoleRow {
  const id = entry.pane ?? ''
  const known = panes.get(id)
  const location = entry.location
  return {
    key: entry.cursor,
    level: entry.type === 'console.message' ? entry.level : 'error',
    pane: known ? { id, label: known.name, color: known.index } : { id, label: id, color: null },
    time: formatTime(entry.time),
    message: oneLine(entry.text),
    location: location
      ? formatLocation(location)
      : entry.type === 'console.message' && entry.url
        ? lastSegment(entry.url)
        : null,
    locationTitle: location
      ? (location.path ?? location.url)
      : entry.type === 'console.message'
        ? entry.url
        : null
  }
}

/**
 * Resolved, the repo-relative path, which is the file a developer would open ([ADR-0020]).
 * Not resolved, the last segment of the script's URL, which is as much as fits.
 */
function formatLocation(location: SourceLocation): string {
  const file = location.path ?? lastSegment(location.url)
  return `${file}:${location.line}:${location.column}`
}

function lastSegment(url: string): string {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    // Not a URL a browser would parse; the text itself is the best there is.
  }
  const segment = path.split('/').filter(Boolean).at(-1)
  return segment ?? url
}

/**
 * Line breaks as spaces, so a clamped message shows its first words rather than its first
 * line alone, and an empty first line never draws an empty row.
 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function formatTime(time: number): string {
  const date = new Date(time)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(
    date.getMilliseconds()
  ).padStart(3, '0')}`
}

/**
 * Collapsing ([ADR-0023]): the same message from several panes is one row carrying each of
 * their pane badges. A property of this view and never of the log — the window collapses
 * continuously over the entries it retains, while `log.read` collapses within one response
 * only — so the two may disagree about how many rows there are while agreeing exactly about
 * what happened.
 */

/**
 * What makes two entries the same message: everything an entry says except when, where in
 * the log, and which pane. Location is in it, so one row is one line of code; the stack is
 * not, because expanding the row is how a reader checks the copies really are identical.
 */
export function collapseKey(entry: ConsoleEntry): string {
  const location = entry.location
  const at = location ? [location.path ?? location.url, location.line, location.column] : null
  return entry.type === 'console.message'
    ? JSON.stringify([entry.type, entry.level, entry.source, entry.text, entry.args, entry.url, at])
    : JSON.stringify([entry.type, entry.rejection, entry.text, entry.error, at])
}

/**
 * Entries that collapse into one row, in cursor order, at most one from each pane: a pane
 * saying something twice said it twice, and the second time is a row of its own. The row
 * sits where its first entry arrived.
 */
export interface ConsoleGroup {
  /** The first entry's cursor, which places the row. */
  readonly cursor: number
  readonly entries: readonly ConsoleEntry[]
}

/**
 * The retained entries, collapsed. A pane's `n`th entry with a key joins the `n`th row with
 * that key, so a matching entry arriving later joins the row that is waiting for its pane
 * rather than starting another, and three panes reloading into the same error twice read
 * as two rows of three, however their entries interleave. Linear in the entries.
 */
export function collapseConsole(entries: readonly ConsoleEntry[]): ConsoleGroup[] {
  const groups: { cursor: number; entries: ConsoleEntry[] }[] = []
  /** Per key, its rows in order, and per pane how many of them that pane is already in. */
  const byKey = new Map<string, { rows: ConsoleEntry[][]; seen: Map<string | null, number> }>()
  for (const entry of entries) {
    const key = collapseKey(entry)
    let known = byKey.get(key)
    if (!known) {
      known = { rows: [], seen: new Map() }
      byKey.set(key, known)
    }
    const n = known.seen.get(entry.pane) ?? 0
    known.seen.set(entry.pane, n + 1)
    const row = known.rows[n]
    if (row) {
      row.push(entry)
    } else {
      const fresh = [entry]
      known.rows.push(fresh)
      groups.push({ cursor: entry.cursor, entries: fresh })
    }
  }
  return groups
}

/** A collapsed row: its first entry's columns, and every pane it carries. */
export interface ConsoleGroupRow extends ConsoleRow {
  /** One per entry, in the panes' project order; a pane no longer in it goes last. */
  badges: ConsolePaneBadge[]
}

export function consoleGroupRow(group: ConsoleGroup, panes: ConsolePanes): ConsoleGroupRow {
  const row = consoleRow(group.entries[0], panes)
  const badges = group.entries
    .map((entry) => consoleRow(entry, panes).pane)
    .sort((a, b) => (a.color ?? Infinity) - (b.color ?? Infinity))
  return { ...row, badges }
}

/**
 * Badges a row draws before the rest become a count, as the prototype draws them: two fit
 * the column at any pane name, and a third would be clipped into a lie about which panes.
 */
export const CONSOLE_BADGES_SHOWN = 2

export function shownBadges(badges: readonly ConsolePaneBadge[]): {
  shown: readonly ConsolePaneBadge[]
  more: readonly ConsolePaneBadge[]
} {
  if (badges.length <= CONSOLE_BADGES_SHOWN) return { shown: badges, more: [] }
  return { shown: badges.slice(0, CONSOLE_BADGES_SHOWN), more: badges.slice(CONSOLE_BADGES_SHOWN) }
}

/**
 * One line of the list, which the virtualiser places at a fixed height: a row, or one of
 * an expanded row's entries beneath it. `cursor` is the row's, for every line of it, so
 * lines are in cursor order whatever an expanded row carries.
 */
export type ConsoleLine =
  | {
      readonly kind: 'group'
      readonly key: string
      readonly cursor: number
      readonly group: ConsoleGroup
    }
  | {
      readonly kind: 'entry'
      readonly key: string
      readonly cursor: number
      readonly entry: ConsoleEntry
    }

/** Whether a row can expand: only one carrying more than one entry has anything to show. */
export function isExpandable(group: ConsoleGroup): boolean {
  return group.entries.length > 1
}

/**
 * Whether a row is expanded, given the cursors the reader expanded. Any of its entries
 * counts, so a row whose first entry was evicted stays open.
 */
export function isExpanded(group: ConsoleGroup, expanded: ReadonlySet<number>): boolean {
  return isExpandable(group) && group.entries.some((entry) => expanded.has(entry.cursor))
}

export function consoleLines(
  groups: readonly ConsoleGroup[],
  expanded: ReadonlySet<number>
): ConsoleLine[] {
  const lines: ConsoleLine[] = []
  for (const group of groups) {
    lines.push({ kind: 'group', key: `g${group.cursor}`, cursor: group.cursor, group })
    if (expanded.size > 0 && isExpanded(group, expanded)) {
      for (const entry of group.entries) {
        lines.push({ kind: 'entry', key: `e${entry.cursor}`, cursor: group.cursor, entry })
      }
    }
  }
  return lines
}

/**
 * Where a reader scrolled up is reading: the line at the top of the viewport, and how far
 * into it. Held by key and its row's cursor rather than by index, because evictions move
 * every index under it.
 */
export interface ConsoleAnchor {
  key: string
  cursor: number
  offset: number
}

/** The anchor at a scroll position, or `null` with nothing to anchor to. */
export function anchorAt(lines: readonly ConsoleLine[], scrollTop: number): ConsoleAnchor | null {
  if (lines.length === 0) return null
  const index = Math.min(lines.length - 1, Math.max(0, Math.floor(scrollTop / CONSOLE_ROW_HEIGHT)))
  const line = lines[index]
  return { key: line.key, cursor: line.cursor, offset: scrollTop - index * CONSOLE_ROW_HEIGHT }
}

/**
 * Whether a scroll position is at the bottom, which is where the list follows new entries.
 * Within half a row, so a fractional scroll position from a zoomed window still counts.
 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollTop >= scrollHeight - clientHeight - CONSOLE_ROW_HEIGHT / 2
}

/**
 * Where the list should be scrolled to once its lines change. Pinned, or with nothing to
 * hold, the bottom. Otherwise wherever the anchored line now is, so entries arriving below
 * move nothing and entries evicted above move the scroll position by exactly their lines.
 * A line that is gone holds the first row after where it was.
 */
export function scrollTarget(
  lines: readonly ConsoleLine[],
  anchor: ConsoleAnchor | null,
  viewport: number
): number {
  if (!anchor) return Math.max(0, lines.length * CONSOLE_ROW_HEIGHT - viewport)
  const first = indexAtOrAfter(lines, anchor.cursor)
  for (let index = first; index < lines.length && lines[index].cursor === anchor.cursor; index++) {
    if (lines[index].key === anchor.key) return index * CONSOLE_ROW_HEIGHT + anchor.offset
  }
  return first * CONSOLE_ROW_HEIGHT
}
