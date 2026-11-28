/**
 * The panel: the docked region beside or below the canvas that holds the Console, and
 * later the Layout, Network, Terminal and Processes tabs ([#49]).
 *
 * Its arrangement — which side it docks to, how big it is there, and whether it is
 * showing — is an app setting rather than a project's. A panel arrangement is how a
 * developer works, not a property of a repo, so switching repos never rearranges the
 * window. It lives beside the theme for the same reason the theme does.
 */

/** Which edge of the canvas the panel docks to. */
export type PanelSide = 'bottom' | 'right'

export const PANEL_SIDES: readonly PanelSide[] = ['bottom', 'right']

/**
 * The panel as arranged. A size is kept per side, in CSS pixels, so docking it the other
 * way and back again returns it to the size it had there: a height and a width are not
 * one number, and carrying a comfortable height across as a width would be a guess.
 *
 * Pixels rather than a share of the window, because a console the developer set to
 * twelve rows should still be twelve rows when the window grows.
 */
export interface PanelState {
  side: PanelSide
  visible: boolean
  sizes: Record<PanelSide, number>
}

/**
 * What `app.setPanel` takes: any of the three, and at least one. `size` is the size of
 * the side the panel is docked to once `side` has been applied, so `{ side, size }` is
 * one move rather than two that would each be drawn.
 */
export interface PanelSetting {
  side?: PanelSide
  visible?: boolean
  size?: number
}

/**
 * The design prototype's panel, before anyone resizes it: `--bp-panel-h` docked below
 * and `--bp-panel-w` docked beside. Mirrored here because the setting has to have a
 * value before any stylesheet is read; a test holds the two in step.
 */
export const DEFAULT_PANEL_SIZES: Readonly<Record<PanelSide, number>> = {
  bottom: 278,
  right: 460
}

/**
 * The least a panel can be, `--bp-tabbar-h`: its tab bar and nothing under it. Smaller
 * than that is a panel that cannot be found again without being hidden and shown.
 */
export const PANEL_MIN_SIZE = 30

/**
 * The least the panel leaves the canvas, `--bp-canvas-min`. A stored size larger than
 * the window can give is kept as asked for and drawn as large as this allows, so a
 * smaller window does not quietly rewrite the setting.
 */
export const CANVAS_MIN_SIZE = 120

export const DEFAULT_PANEL: PanelState = {
  side: 'bottom',
  visible: true,
  sizes: { ...DEFAULT_PANEL_SIZES }
}

export function isPanelSide(value: unknown): value is PanelSide {
  return value === 'bottom' || value === 'right'
}

/** A whole number of pixels, no smaller than the tab bar. */
export function clampPanelSize(size: number): number {
  return Math.max(PANEL_MIN_SIZE, Math.round(size))
}

/** The arrangement after a setting, with `size` applying to the side it ends up on. */
export function applyPanelSetting(state: PanelState, setting: PanelSetting): PanelState {
  const side = setting.side ?? state.side
  const visible = setting.visible ?? state.visible
  const sizes =
    setting.size === undefined
      ? state.sizes
      : { ...state.sizes, [side]: clampPanelSize(setting.size) }
  return { side, visible, sizes }
}

export function samePanel(a: PanelState, b: PanelState): boolean {
  return (
    a.side === b.side &&
    a.visible === b.visible &&
    PANEL_SIDES.every((side) => a.sizes[side] === b.sizes[side])
  )
}

/** The size the panel is drawn at, on the side it is docked to. */
export function panelSize(state: PanelState): number {
  return state.sizes[state.side]
}

export type ReadPanelResult = { ok: true; panel: PanelState } | { ok: false; message: string }

/**
 * The panel as the settings file spells it. Absent fields take their defaults, so a file
 * from before a field existed is read; a field present and wrong is refused, the way the
 * rest of the file is.
 */
export function readPanel(raw: unknown): ReadPanelResult {
  if (raw === undefined) return { ok: true, panel: copy(DEFAULT_PANEL) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'panel must be an object' }
  }
  const { side, visible, sizes } = raw as Record<string, unknown>
  if (side !== undefined && !isPanelSide(side)) {
    return { ok: false, message: 'panel.side must be bottom or right' }
  }
  if (visible !== undefined && typeof visible !== 'boolean') {
    return { ok: false, message: 'panel.visible must be true or false' }
  }
  const read: Record<PanelSide, number> = { ...DEFAULT_PANEL_SIZES }
  if (sizes !== undefined) {
    if (typeof sizes !== 'object' || sizes === null || Array.isArray(sizes)) {
      return { ok: false, message: 'panel.sizes must be an object' }
    }
    for (const edge of PANEL_SIDES) {
      const size = (sizes as Record<string, unknown>)[edge]
      if (size === undefined) continue
      if (!isPanelSize(size)) {
        return { ok: false, message: `panel.sizes.${edge} must be a number of pixels` }
      }
      read[edge] = clampPanelSize(size)
    }
  }
  return {
    ok: true,
    panel: {
      side: side ?? DEFAULT_PANEL.side,
      visible: visible ?? DEFAULT_PANEL.visible,
      sizes: read
    }
  }
}

/** A size a route or a file may carry: a finite, positive number. Clamped after. */
export function isPanelSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function copy(state: PanelState): PanelState {
  return { ...state, sizes: { ...state.sizes } }
}
