import type { CanvasChrome } from '../../../shared/canvas'

/**
 * What the canvas spends on chrome, read off the tokens on the element itself rather
 * than repeated as numbers here. Fit is arithmetic over screen pixels, and these are the
 * screen pixels it cannot give to panes.
 */
export function readCanvasChrome(element: Element): CanvasChrome {
  const style = getComputedStyle(element)
  const px = (token: string): number => Number.parseFloat(style.getPropertyValue(token)) || 0

  const space = px('--bp-space-5')
  const stroke = px('--bp-stroke')
  return {
    padding: space,
    gap: space,
    // The rim across, the header and the rim under it down; both hold their screen size.
    pane: { width: stroke * 2, height: px('--bp-row') + stroke }
  }
}

/** The drawn height of a pane in the Focus strip, whatever the pane declares. */
export function readStripHeight(element: Element): number {
  return Number.parseFloat(getComputedStyle(element).getPropertyValue('--bp-strip-h')) || 0
}

/** The gap between panes in the Focus strip. */
export function readStripGap(element: Element): number {
  return Number.parseFloat(getComputedStyle(element).getPropertyValue('--bp-space-3')) || 0
}

/**
 * What the header's rotate and remove buttons occupy, in screen pixels: two square
 * controls, the gap between them, and the gap separating the pair from what the header
 * says. Composed from the tokens they are drawn with rather than written down as a
 * number, so moving a token moves the width the ladder reserves for them.
 */
export function readPaneActionsWidth(element: Element): number {
  const style = getComputedStyle(element)
  const px = (token: string): number => Number.parseFloat(style.getPropertyValue(token)) || 0
  return px('--bp-pane-tab-h') * 2 + px('--bp-space-1') + px('--bp-space-2')
}
