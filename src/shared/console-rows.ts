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
 * Where a reader scrolled up is reading: the entry at the top of the viewport, and how far
 * into its row. Held by cursor rather than index, because evictions move every index under
 * it.
 */
export interface ConsoleAnchor {
  cursor: number
  offset: number
}

/** The anchor at a scroll position, or `null` with nothing to anchor to. */
export function anchorAt(
  entries: readonly ConsoleEntry[],
  scrollTop: number
): ConsoleAnchor | null {
  if (entries.length === 0) return null
  const index = Math.min(
    entries.length - 1,
    Math.max(0, Math.floor(scrollTop / CONSOLE_ROW_HEIGHT))
  )
  return { cursor: entries[index].cursor, offset: scrollTop - index * CONSOLE_ROW_HEIGHT }
}

/**
 * Whether a scroll position is at the bottom, which is where the list follows new entries.
 * Within half a row, so a fractional scroll position from a zoomed window still counts.
 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollTop >= scrollHeight - clientHeight - CONSOLE_ROW_HEIGHT / 2
}

/**
 * Where the list should be scrolled to once its entries change. Pinned, or with nothing to
 * hold, the bottom. Otherwise wherever the anchored entry now is, so entries arriving below
 * move nothing and entries evicted above move the scroll position by exactly their rows. An
 * anchor that was itself evicted holds the first entry after it.
 */
export function scrollTarget(
  entries: readonly ConsoleEntry[],
  anchor: ConsoleAnchor | null,
  viewport: number
): number {
  if (!anchor) return Math.max(0, entries.length * CONSOLE_ROW_HEIGHT - viewport)
  const index = indexAtOrAfter(entries, anchor.cursor)
  const same = entries[index]?.cursor === anchor.cursor
  return index * CONSOLE_ROW_HEIGHT + (same ? anchor.offset : 0)
}
