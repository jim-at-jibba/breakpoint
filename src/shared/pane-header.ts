import type { CapabilityState, EmulationState } from './panes'
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

export interface PaneHeaderTier {
  /** The narrowest pane width in screen pixels this tier draws at. */
  readonly minWidth: number
  readonly name: boolean
  /** The declared width. The last thing to go, because it is what names a pane. */
  readonly width: boolean
  readonly height: boolean
  readonly dpr: boolean
  readonly scheme: boolean
}

export const PANE_HEADER_TIERS: readonly PaneHeaderTier[] = [
  { minWidth: 220, name: true, width: true, height: true, dpr: true, scheme: true },
  { minWidth: 148, name: true, width: true, height: true, dpr: false, scheme: true },
  { minWidth: 104, name: false, width: true, height: true, dpr: false, scheme: true },
  { minWidth: 72, name: false, width: true, height: false, dpr: false, scheme: true },
  { minWidth: 56, name: false, width: true, height: false, dpr: false, scheme: false },
  { minWidth: 0, name: false, width: false, height: false, dpr: false, scheme: false }
]

/** The tier that claims nothing: the colour tab and the error count alone. */
const NARROWEST = PANE_HEADER_TIERS[PANE_HEADER_TIERS.length - 1]

/**
 * What the header says at this drawn width. A width that cannot be read as one — not a
 * number, or negative because something was measured mid-layout — falls to the narrowest
 * tier: a header that cannot be measured claims nothing.
 */
export function paneHeaderTier(width: number): PaneHeaderTier {
  if (!Number.isFinite(width)) return NARROWEST
  return PANE_HEADER_TIERS.find((tier) => width >= tier.minWidth) ?? NARROWEST
}

/**
 * Rotate and remove are not on the ladder — the ladder is what a header *says*, and
 * these are things it does. They occupy `--bp-pane-tab-h` each plus the gaps between
 * them, so they are shown only above the widest tier's threshold plus that much again:
 * below it they would take the width the tier's own content was measured to need.
 */
export const PANE_ACTIONS_MIN_WIDTH = PANE_HEADER_TIERS[0].minWidth + 32

export function paneHeaderHasActions(width: number): boolean {
  return Number.isFinite(width) && width >= PANE_ACTIONS_MIN_WIDTH
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

/** The pane's device pixel ratio as the header writes it. */
export function formatDpr(dpr: number): string {
  return `@${dpr}x`
}

/**
 * A header reports what is emulated, not what was asked for, so every field it draws is
 * drawn against the state of the capability that would make it true. A field whose
 * capability is not applied is marked rather than hidden: a pane claiming 390px while
 * the override was refused is the failure mode the whole degraded concept exists for.
 */
export function fieldState(
  emulation: EmulationState | undefined,
  field: HeaderField
): CapabilityState {
  return emulation?.[FIELD_CAPABILITY[field]] ?? 'pending'
}

export type HeaderField = 'viewport' | 'dpr' | 'scheme'

const FIELD_CAPABILITY = {
  // DPR is part of the device metrics override, so it stands or falls with the viewport.
  viewport: 'viewport',
  dpr: 'viewport',
  scheme: 'colorScheme'
} as const

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
