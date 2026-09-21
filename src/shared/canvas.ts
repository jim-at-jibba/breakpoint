import type { Size } from './panes'
import type { Pane, Zoom } from './project'

/**
 * The canvas's arithmetic: what zoom each pane is drawn at.
 *
 * Zoom is renderer-owned — it is a canvas transform and the main process never learns
 * it — but the numbers live here, because they are the contract between the renderer
 * that draws a pane and the host-side geometry check that verifies it against declared
 * size times zoom ([ADR-0004]).
 *
 * Every function is pure and takes its screen pixels as arguments; nothing here reads
 * the DOM or the tokens.
 */

/** PRD 6.3 L1. At 25% a mobile pane is ~100px wide, which is the last readable tier. */
export const MIN_ZOOM = 25
export const MAX_ZOOM = 100

/**
 * The screen pixels the canvas spends on chrome rather than on panes. All of it holds
 * its screen size whatever the zoom, so it comes off the viewport before anything is
 * scaled.
 */
export interface CanvasChrome {
  /** Around the pane strip, on each side. */
  padding: number
  /** Between two panes. */
  gap: number
  /** What one pane occupies beyond its drawn page: its rim across, its header down. */
  pane: Size
}

/**
 * A zoom the control can hold: a whole percent between 25 and 100. A value that is not
 * a number reads as 100%, the zoom that changes nothing about how a pane is drawn.
 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return MAX_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value)))
}

/**
 * Fit: the largest zoom at which every pane is drawn without the canvas scrolling
 * ([ADR-0009]). Whole percents, rounded down, so the answer fits rather than nearly
 * fits — and floored at 25%, below which the panes stop being readable and a scrolling
 * canvas is the better answer.
 */
export function fitZoom(panes: readonly Size[], viewport: Size, chrome: CanvasChrome): number {
  if (panes.length === 0) return MAX_ZOOM

  const across =
    viewport.width -
    chrome.padding * 2 -
    chrome.gap * (panes.length - 1) -
    chrome.pane.width * panes.length
  const down = viewport.height - chrome.padding * 2 - chrome.pane.height

  // Side by side, so the panes' declared widths add up and only the tallest sets the height.
  const declaredWidth = panes.reduce((total, pane) => total + pane.width, 0)
  const declaredHeight = Math.max(...panes.map((pane) => pane.height))

  // Percent first, then floor: dividing pixels by pixels keeps the division exact where
  // multiplying a fraction by 100 would land a whole percent a rounding error below it.
  return clampZoom(
    Math.floor(Math.min((across * 100) / declaredWidth, (down * 100) / declaredHeight))
  )
}

/**
 * The one zoom a pane is drawn at, given what the project stores and what Fit currently
 * computes to. Fit is a value of the zoom control, so resolving it is all that separates
 * the stored value from the drawn one — there is no mode to consult ([ADR-0009]).
 */
export function resolveZoom(zoom: Zoom, fit: number): number {
  return zoom === 'fit' ? fit : clampZoom(zoom)
}

/**
 * The zoom an unfocused pane is drawn at in Focus layout: scaled to the strip's height
 * whatever its declared size, so the strip reads as one row. Never magnified, and not
 * subject to the zoom control's 25% floor — the strip is a layout, not a zoom.
 */
export function stripZoom(pane: Size, stripHeight: number): number {
  return Math.min(MAX_ZOOM, (stripHeight * 100) / pane.height)
}

/**
 * The pane Focus draws at 100%. A project that names none, or names one that has since
 * gone, focuses its first pane rather than nothing: Focus with nothing focused is not a
 * state the layout has.
 */
export function focusedPaneOf(
  panes: readonly Pane[],
  focusedPane: string | null
): Pane | undefined {
  return panes.find((pane) => pane.id === focusedPane) ?? panes[0]
}
