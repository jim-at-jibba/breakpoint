/**
 * The display floor ([ADR-0022]): the log position at or below which this window's Console
 * shows nothing. What Clear sets.
 *
 * The log is shared history that the CLI reads by cursor and MCP will, so Clear never
 * truncates it. It records a position instead, and the window hides what is at or below
 * it. No read consults the floor: `breakpoint logs --since 0` still returns everything, and
 * the CLI's equivalent of a floor is the `--since` it passed. Nor does any pane's error
 * count move, because a count that a view action can zero is one no surface can trust.
 *
 * Preserving the log across navigation is therefore free, and is the default. *Not*
 * preserving is the floor moved when the project navigates, and that is the setting.
 */

/**
 * The Console's state as the snapshot carries it. `floor` lives as long as the app does,
 * so a reloaded window restores it; `preserveLog` is an app setting, kept on this machine.
 */
export interface ConsoleDisplay {
  /** The log position at or below which nothing is shown. `0` hides nothing. */
  floor: number
  /** Whether entries survive the project navigating. Off moves the floor on navigate. */
  preserveLog: boolean
}

/** The Console's stored settings: the part of `ConsoleDisplay` that outlives a run. */
export interface ConsoleSettings {
  preserveLog: boolean
}

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = { preserveLog: true }

export const DEFAULT_CONSOLE_DISPLAY: ConsoleDisplay = {
  floor: 0,
  ...DEFAULT_CONSOLE_SETTINGS
}

/**
 * The floor raised to `position`, and never lowered. A floor only ever moves forward: a
 * Clear or a navigation that is heard late, behind one that came after it, must not bring
 * back entries the later one hid.
 */
export function raiseFloor(floor: number, position: number): number {
  return Math.max(floor, position)
}

/** What Clear does: everything up to the log's last position, `head`, is hidden. */
export function clearConsole(display: ConsoleDisplay, head: number): ConsoleDisplay {
  const floor = raiseFloor(display.floor, head)
  return floor === display.floor ? display : { ...display, floor }
}

/**
 * The project navigated, and `position` is where the log recorded it. Preserving, which is
 * the default, changes nothing. Not preserving raises the floor to that position, so what
 * the pages said before they were sent away is hidden and everything after it shows.
 */
export function navigatedConsole(display: ConsoleDisplay, position: number): ConsoleDisplay {
  if (display.preserveLog) return display
  return clearConsole(display, position)
}

/**
 * The entries a window with this floor shows: those after it. Entries are in cursor
 * order, so the first one shown is found by binary search, and the same array comes back
 * when the floor hides none of them.
 */
export function aboveFloor<T extends { readonly cursor: number }>(
  entries: readonly T[],
  floor: number
): readonly T[] {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (entries[middle].cursor <= floor) low = middle + 1
    else high = middle
  }
  return low === 0 ? entries : entries.slice(low)
}

export type ReadConsoleSettingsResult =
  { ok: true; console: ConsoleSettings } | { ok: false; message: string }

/**
 * The Console's settings as the settings file spells them. Absent takes the default, so a
 * file from before the Console existed is read; present and wrong is refused.
 */
export function readConsoleSettings(raw: unknown): ReadConsoleSettingsResult {
  if (raw === undefined) return { ok: true, console: { ...DEFAULT_CONSOLE_SETTINGS } }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'console must be an object' }
  }
  const { preserveLog } = raw as Record<string, unknown>
  if (preserveLog !== undefined && typeof preserveLog !== 'boolean') {
    return { ok: false, message: 'console.preserveLog must be true or false' }
  }
  return {
    ok: true,
    console: { preserveLog: preserveLog ?? DEFAULT_CONSOLE_SETTINGS.preserveLog }
  }
}
