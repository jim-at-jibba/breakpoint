import { describe, expect, test } from 'vitest'
import {
  PANE_ACTIONS_MIN_WIDTH,
  PANE_HEADER_TIERS,
  describeFieldState,
  fieldState,
  formatDpr,
  paneHeaderHasActions,
  paneHeaderTier,
  schemeGlyph,
  type PaneHeaderTier
} from './pane-header'
import { initialPaneStatus } from './panes'

/** What a tier still says, as the ladder in the design prototype writes it. */
function contentOf(tier: PaneHeaderTier): string[] {
  return (['name', 'width', 'height', 'dpr', 'scheme'] as const).filter((field) => tier[field])
}

describe('the header degradation ladder', () => {
  test('says everything at the widest tier', () => {
    expect(contentOf(paneHeaderTier(220))).toEqual(['name', 'width', 'height', 'dpr', 'scheme'])
    expect(contentOf(paneHeaderTier(1440))).toEqual(['name', 'width', 'height', 'dpr', 'scheme'])
  })

  test('drops DPR first, then the name, then the height, then the scheme', () => {
    expect(contentOf(paneHeaderTier(219))).toEqual(['name', 'width', 'height', 'scheme'])
    expect(contentOf(paneHeaderTier(147))).toEqual(['width', 'height', 'scheme'])
    expect(contentOf(paneHeaderTier(103))).toEqual(['width', 'scheme'])
    expect(contentOf(paneHeaderTier(71))).toEqual(['width'])
  })

  test('is the colour tab and the error count alone below 56px', () => {
    expect(contentOf(paneHeaderTier(55))).toEqual([])
    expect(contentOf(paneHeaderTier(32))).toEqual([])
    expect(contentOf(paneHeaderTier(0))).toEqual([])
  })

  test('takes each threshold as the narrowest width that tier draws at', () => {
    for (const tier of PANE_HEADER_TIERS) {
      expect(paneHeaderTier(tier.minWidth)).toBe(tier)
      if (tier.minWidth > 0) expect(paneHeaderTier(tier.minWidth - 1)).not.toBe(tier)
    }
  })

  test('only ever sheds content as the pane narrows', () => {
    let last = contentOf(paneHeaderTier(2000))
    for (let width = 2000; width >= 0; width -= 1) {
      const next = contentOf(paneHeaderTier(width))
      expect(next.every((field) => last.includes(field))).toBe(true)
      last = next
    }
  })

  test('claims nothing for a width it cannot read', () => {
    expect(contentOf(paneHeaderTier(Number.NaN))).toEqual([])
    expect(contentOf(paneHeaderTier(-10))).toEqual([])
  })
})

describe('the header actions', () => {
  test('come off before the ladder starts shedding what the header says', () => {
    expect(PANE_ACTIONS_MIN_WIDTH).toBeGreaterThan(PANE_HEADER_TIERS[0].minWidth)
    expect(paneHeaderHasActions(PANE_ACTIONS_MIN_WIDTH)).toBe(true)
    expect(paneHeaderHasActions(PANE_ACTIONS_MIN_WIDTH - 1)).toBe(false)
    expect(paneHeaderHasActions(Number.NaN)).toBe(false)
  })
})

describe('what a header field says', () => {
  test('writes DPR the way a preset does', () => {
    expect(formatDpr(3)).toBe('@3x')
    expect(formatDpr(1)).toBe('@1x')
  })

  test('gives every colour scheme a glyph, including system', () => {
    const glyphs = (['light', 'dark', 'system'] as const).map(schemeGlyph)
    expect(new Set(glyphs).size).toBe(3)
    expect(glyphs.every((glyph) => glyph.length > 0)).toBe(true)
  })
})

describe('a field against the emulation actually applied', () => {
  test('reads the capability that would make the field true', () => {
    const emulation = { ...initialPaneStatus().emulation, viewport: 'failed' as const }
    expect(fieldState(emulation, 'viewport')).toBe('failed')
    // DPR rides on the device metrics override, so it fails with the viewport.
    expect(fieldState(emulation, 'dpr')).toBe('failed')
    expect(fieldState(emulation, 'scheme')).toBe('pending')
  })

  test('reads as pending for a pane nothing is known about yet', () => {
    expect(fieldState(undefined, 'viewport')).toBe('pending')
  })

  test('says why a marked field is marked', () => {
    expect(describeFieldState('viewport', 'failed')).toBe('viewport declared but not emulated')
    expect(describeFieldState('scheme', 'applied')).toBe('colour scheme emulated as declared')
    expect(describeFieldState('dpr', 'pending')).toBe('DPR not yet emulated')
  })
})
