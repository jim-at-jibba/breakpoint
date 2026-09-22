import type { AppTheme } from './theme'

/**
 * Pane identity: ten colours separated by hue alone.
 *
 * One OKLCH lightness and one low chroma per app theme, so no pane can look more
 * important than another and the set survives being rasterised into a composite
 * screenshot — hue discriminates reliably at equal value where saturation does not.
 *
 * The colours are generated from one formula here rather than copied out of the design
 * tokens, because the tokens are CSS and a composite screenshot is drawn where there is
 * none. `paneColorToken` is what the window uses, so the drawn chrome still reads its
 * value off `--bp-pane-1` … `--bp-pane-10`; `paneColor` is the same colour for anything
 * that cannot. `pane-palette.test.ts` holds the two to each other.
 */

/**
 * The hues, in the order panes take them. Hand-picked for separation rather than spaced
 * evenly: equal steps round the wheel are not equal steps to the eye.
 */
export const PANE_HUES = [218, 168, 128, 82, 28, 332, 248, 196, 52, 302] as const

export const PANE_PALETTE_SIZE = PANE_HUES.length

/** Lightness and chroma hold across the set; only the hue moves. */
export interface PaneTone {
  lightness: number
  chroma: number
}

/**
 * One tone per theme: lighter and slightly less chromatic on dark chrome, darker and
 * slightly more chromatic on light, so the tab reads at the same strength on both.
 */
export const PANE_TONES: Readonly<Record<AppTheme, PaneTone>> = {
  dark: { lightness: 0.76, chroma: 0.105 },
  light: { lightness: 0.55, chroma: 0.115 }
}

/**
 * The palette position a pane at `index` in the set takes. Wraps, so an eleventh pane
 * repeats the first colour rather than having none, and a negative index is still a
 * position rather than a gap.
 */
export function paneColorIndex(index: number): number {
  const size = PANE_PALETTE_SIZE
  return ((Math.trunc(index) % size) + size) % size
}

/** The custom property holding this pane's colour: `--bp-pane-1` … `--bp-pane-10`. */
export function paneColorToken(index: number): string {
  return `--bp-pane-${paneColorIndex(index) + 1}`
}

/** What a component sets a colour to. No component picks a pane colour any other way. */
export function paneColorVar(index: number): string {
  return `var(${paneColorToken(index)})`
}

/**
 * The colour itself, for anything drawing outside CSS — the composite screenshot's pane
 * borders. Three decimal places on lightness and chroma, which is what the tokens carry.
 */
export function paneColor(index: number, theme: AppTheme): string {
  const { lightness, chroma } = PANE_TONES[theme]
  return `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${PANE_HUES[paneColorIndex(index)]})`
}
