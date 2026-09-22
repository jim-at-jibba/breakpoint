import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  fitZoom,
  focusedPaneOf,
  MAX_ZOOM,
  MIN_ZOOM,
  resolveZoom,
  stripZoom,
  type CanvasChrome
} from './canvas'
import type { Size } from './panes'
import { createProject } from './project'

/** The real chrome: 16px of canvas padding and gap, a 24px header and a 1px rim. */
const chrome: CanvasChrome = { padding: 16, gap: 16, pane: { width: 2, height: 25 } }

const mobile: Size = { width: 390, height: 844 }
const tablet: Size = { width: 820, height: 1180 }
const desktop: Size = { width: 1440, height: 900 }

describe('clampZoom', () => {
  it('keeps a zoom inside 25-100 and rounds it to a whole percent', () => {
    expect(clampZoom(43.4)).toBe(43)
    expect(clampZoom(MIN_ZOOM)).toBe(25)
    expect(clampZoom(MAX_ZOOM)).toBe(100)
  })

  it('clamps a zoom outside the range to the nearest end', () => {
    expect(clampZoom(0)).toBe(25)
    expect(clampZoom(-200)).toBe(25)
    expect(clampZoom(24.9)).toBe(25)
    expect(clampZoom(101)).toBe(100)
    expect(clampZoom(10_000)).toBe(100)
  })

  it('reads a value that is not a number as the zoom that changes nothing', () => {
    expect(clampZoom(Number.NaN)).toBe(100)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(100)
  })
})

describe('fitZoom', () => {
  it('is the largest whole percent at which every pane is drawn without scrolling', () => {
    const panes = [mobile, tablet, desktop]
    const viewport = { width: 1600, height: 1000 }

    const zoom = fitZoom(panes, viewport, chrome)

    const drawn = (size: number): number => (size * zoom) / 100
    const width =
      chrome.padding * 2 +
      chrome.gap * (panes.length - 1) +
      panes.reduce((total, pane) => total + drawn(pane.width) + chrome.pane.width, 0)
    const height =
      chrome.padding * 2 + chrome.pane.height + Math.max(...panes.map((pane) => drawn(pane.height)))
    expect(width).toBeLessThanOrEqual(viewport.width)
    expect(height).toBeLessThanOrEqual(viewport.height)

    // And one percent more would not fit: this is the largest that does, not merely one that does.
    const wider = panes.reduce((total, pane) => total + pane.width, 0) * ((zoom + 1) / 100)
    expect(chrome.padding * 2 + chrome.gap * 2 + chrome.pane.width * 3 + wider).toBeGreaterThan(
      viewport.width
    )
  })

  it('fits to whichever of width and height runs out first', () => {
    const short = fitZoom([desktop], { width: 4000, height: 300 }, chrome)
    const narrow = fitZoom([desktop], { width: 500, height: 4000 }, chrome)

    // 300 - 32 - 25 = 243 of 900; 500 - 32 - 2 = 466 of 1440.
    expect(short).toBe(27)
    expect(narrow).toBe(32)
  })

  it('recomputes when a pane is added, removed or resized', () => {
    const viewport = { width: 1600, height: 1000 }
    const two = fitZoom([mobile, tablet], viewport, chrome)

    expect(fitZoom([mobile, tablet, desktop], viewport, chrome)).toBeLessThan(two)
    expect(fitZoom([mobile], viewport, chrome)).toBeGreaterThan(two)
    expect(fitZoom([mobile, { width: 2000, height: 1180 }], viewport, chrome)).toBeLessThan(two)
  })

  it('never goes below 25%, where the canvas scrolls instead', () => {
    expect(fitZoom([desktop, desktop, desktop], { width: 200, height: 200 }, chrome)).toBe(25)
    expect(fitZoom([desktop], { width: 0, height: 0 }, chrome)).toBe(25)
  })

  it('never goes above 100%: Fit makes panes visible, it does not magnify them', () => {
    expect(fitZoom([mobile], { width: 6000, height: 6000 }, chrome)).toBe(100)
  })

  it('is 100% with no panes to fit', () => {
    expect(fitZoom([], { width: 1600, height: 1000 }, chrome)).toBe(100)
  })
})

describe('resolveZoom', () => {
  it('reads Fit as the computed fit, so one value answers what the pane is drawn at', () => {
    expect(resolveZoom('fit', 43)).toBe(43)
  })

  it('reads a concrete zoom as itself, clamped', () => {
    expect(resolveZoom(50, 43)).toBe(50)
    expect(resolveZoom(120, 43)).toBe(100)
  })
})

describe('stripZoom', () => {
  it('draws an unfocused pane at the strip height, whatever its declared size', () => {
    expect(stripZoom(tablet, 118) * tablet.height).toBeCloseTo(118 * 100)
    expect(stripZoom(mobile, 118) * mobile.height).toBeCloseTo(118 * 100)
  })

  it('never magnifies a pane shorter than the strip', () => {
    expect(stripZoom({ width: 100, height: 60 }, 118)).toBe(100)
  })
})

describe('focusedPaneOf', () => {
  const { panes } = createProject('/repos/shop')
  const [first, , third] = panes

  it('is the named pane', () => {
    expect(focusedPaneOf(panes, third.id)).toBe(third)
  })

  it('falls back to the first pane when none is named or the named one is gone', () => {
    expect(focusedPaneOf(panes, null)).toBe(first)
    expect(focusedPaneOf(panes, 'gone')).toBe(first)
  })

  it('is undefined when there are no panes', () => {
    expect(focusedPaneOf([], first.id)).toBeUndefined()
  })
})
