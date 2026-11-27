import type { ThemeState } from './theme'
import type { CapabilityState, PaneStatus } from './panes'
import type { ColorScheme } from './project'

/**
 * The pane header's degradation ladder ([ADR-0010]).
 *
 * A header holds a fixed screen size and is clipped by its own pane, so it can never
 * claim width the pane does not have. What it can still say at a given width is decided
 * here, as a pure function of that width in screen pixels: the canvas zoom is already
 * baked into the number, and Focus draws its panes at different zooms, so the zoom is
 * not something this can be asked about.
 *
 * Six tiers. DPR drops first — it is the least often wrong and the easiest to check
 * elsewhere — then the name, then the height, then the scheme glyph, ending at the
 * colour tab and the error count alone. Each threshold is the narrowest width at which
 * the remaining content still draws without clipping, and they come from the design
 * prototype rather than from arithmetic here.
 */

/** What a header still says. Every field is the pane's, and every one can be dropped. */
export interface PaneHeaderContent {
  readonly name: boolean
  /** The declared width. The last thing to go, because it is what names a pane. */
  readonly width: boolean
  readonly height: boolean
  readonly dpr: boolean
  readonly scheme: boolean
}

export interface PaneHeaderTier {
  /** The narrowest pane width in screen pixels this tier draws at. */
  readonly minWidth: number
  readonly shows: PaneHeaderContent
}

export const PANE_HEADER_TIERS: readonly PaneHeaderTier[] = [
  { minWidth: 220, shows: { name: true, width: true, height: true, dpr: true, scheme: true } },
  { minWidth: 148, shows: { name: true, width: true, height: true, dpr: false, scheme: true } },
  { minWidth: 104, shows: { name: false, width: true, height: true, dpr: false, scheme: true } },
  { minWidth: 72, shows: { name: false, width: true, height: false, dpr: false, scheme: true } },
  { minWidth: 56, shows: { name: false, width: true, height: false, dpr: false, scheme: false } },
  { minWidth: 0, shows: { name: false, width: false, height: false, dpr: false, scheme: false } }
]

/** The tier that says nothing: the colour tab and the error count alone. */
const SILENT = PANE_HEADER_TIERS[PANE_HEADER_TIERS.length - 1]

/**
 * What the header says at this drawn width. A width that cannot be read as one — not a
 * number, or negative because something was measured mid-layout — falls to the narrowest
 * tier: a header that cannot be measured claims nothing.
 */
export function paneHeaderTier(width: number): PaneHeaderTier {
  if (!Number.isFinite(width)) return SILENT
  return PANE_HEADER_TIERS.find((tier) => width >= tier.minWidth) ?? SILENT
}

/**
 * Whether the tier has room for anything at all. What is left at that point — the colour
 * tab and the error count — is not text and does not need room made for it, so anything
 * else the header would draw is gated on this rather than on one of the fields.
 */
export function paneHeaderIsSilent(tier: PaneHeaderTier): boolean {
  return tier === SILENT
}

/**
 * Rotate and remove are not on the ladder — the ladder is what a header *says*, and these
 * are things it does. They come off above the widest tier's threshold, because below that
 * they would take the width that tier's own content was measured to need. How much width
 * they take is measured off the tokens they are drawn from, not written down here.
 */
export function paneHeaderHasActions(width: number, actionsWidth: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(actionsWidth)) return false
  return width >= PANE_HEADER_TIERS[0].minWidth + actionsWidth
}

/**
 * What a pane's scheme reads as in a header. `system` is the pane following the OS, which
 * is neither of the two things it could be following it to.
 */
export function schemeGlyph(scheme: ColorScheme): string {
  switch (scheme) {
    case 'light':
      return '☀'
    case 'dark':
      return '☾'
    case 'system':
      return '◐'
  }
}

/**
 * Whether a pane is rendering the page in something other than the app's own appearance.
 * The colour tab carries this once the tier has taken the glyph away. A `system` pane
 * follows the desktop, which can differ from an app override ([CONTEXT.md]).
 */
export function schemeDiffersFromApp(scheme: ColorScheme, theme: ThemeState): boolean {
  const paneTheme = scheme === 'system' ? theme.system : scheme
  return paneTheme !== theme.active
}

/** The pane's device pixel ratio as the header writes it. */
export function formatDpr(dpr: number): string {
  return `@${dpr}x`
}

/** What a pane's error count reads as, in a header or on a terminal. */
export function describeErrors(errors: number): string {
  return `${errors} ${errors === 1 ? 'error' : 'errors'}`
}

/**
 * Whether a pane's header is flashing, folded over the error counts the window sees for
 * that pane. `flashes` numbers the flashes begun, so a view can start each one afresh.
 */
export interface ErrorFlash {
  /** The last count seen: what the next count is compared against. */
  count: number
  flashing: boolean
  flashes: number
}

/**
 * Where a header starts: from the count it first sees, not from zero. A window that opens
 * onto a pane already carrying errors learns a number; nothing rose, so nothing flashes.
 */
export function initialErrorFlash(errors: number): ErrorFlash {
  return { count: errors, flashing: false, flashes: 0 }
}

/**
 * A rise in the count starts a flash, and only when none is running. A burst — any number
 * of rises while a flash runs — is absorbed by the flash already running, so errors
 * arriving faster than one flash lasts can never stack into a strobe. A fall is a pane
 * navigating, which says nothing went wrong: it moves the baseline and nothing else.
 */
export function foldErrorFlash(state: ErrorFlash, errors: number): ErrorFlash {
  if (errors === state.count) return state
  if (errors < state.count || state.flashing) return { ...state, count: errors }
  return { count: errors, flashing: true, flashes: state.flashes + 1 }
}

/** The flash has run its course; the next rise may start another. */
export function endErrorFlash(state: ErrorFlash): ErrorFlash {
  return state.flashing ? { ...state, flashing: false } : state
}

export type HeaderField = 'viewport' | 'dpr' | 'scheme'

const FIELD_CAPABILITY = {
  // DPR is part of the device metrics override, so it stands or falls with the viewport.
  viewport: 'viewport',
  dpr: 'viewport',
  scheme: 'colorScheme'
} as const

/**
 * A header reports what is emulated, not what was asked for, so every field it draws is
 * drawn against the state of the thing that would make it true. A field whose capability
 * is not applied is marked rather than hidden: a pane claiming 390px while the override
 * was refused is the failure mode the whole degraded concept exists for.
 *
 * The viewport answers to the host-side geometry check as well as to CDP. A pane drawn at
 * a size other than it declares is not emulating the viewport it claims however happily
 * the override was accepted — that is the whole point of checking it host-side
 * ([ADR-0004]).
 */
export function paneFieldState(
  status: PaneStatus | undefined,
  field: HeaderField
): CapabilityState {
  const capability = FIELD_CAPABILITY[field]
  if (capability === 'viewport' && status?.geometry === 'mismatch') return 'failed'
  return status?.emulation[capability] ?? 'pending'
}

/** What a field's state means to a person, for the title a marked field carries. */
export function describeFieldState(field: HeaderField, state: CapabilityState): string {
  const subject = field === 'scheme' ? 'colour scheme' : field === 'dpr' ? 'DPR' : 'viewport'
  switch (state) {
    case 'applied':
      return `${subject} emulated as declared`
    case 'pending':
      return `${subject} not yet emulated`
    case 'failed':
      return `${subject} declared but not emulated`
  }
}
