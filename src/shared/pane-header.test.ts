import { describe, expect, test } from 'vitest'
import {
  describeErrors,
  describeFieldState,
  formatDpr,
  PANE_HEADER_TIERS,
  paneFieldState,
  paneHeaderHasActions,
  paneHeaderIsSilent,
  paneHeaderTier,
  schemeDiffersFromApp,
  schemeGlyph,
  type PaneHeaderTier
} from './pane-header'
import { foldPaneStatus, initialPaneStatus, type PaneStatus } from './panes'

/** What a tier still says, as the ladder in the design prototype writes it. */
function contentOf(tier: PaneHeaderTier): string[] {
  return (['name', 'width', 'height', 'dpr', 'scheme'] as const).filter(
    (field) => tier.shows[field]
  )
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
    for (const width of [55, 32, 0]) {
      expect(contentOf(paneHeaderTier(width))).toEqual([])
      expect(paneHeaderIsSilent(paneHeaderTier(width))).toBe(true)
    }
    expect(paneHeaderIsSilent(paneHeaderTier(56))).toBe(false)
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
  // What two tab-height buttons, the gap between them and the gap before them occupy,
  // as the renderer measures it off the tokens they are drawn with.
  const actions = 12 * 2 + 2 + 4

  test('come off before the ladder starts shedding what the header says', () => {
    const widest = PANE_HEADER_TIERS[0].minWidth
    expect(paneHeaderHasActions(widest + actions, actions)).toBe(true)
    expect(paneHeaderHasActions(widest + actions - 1, actions)).toBe(false)
    // Never at a width the widest tier's own content already fills.
    expect(paneHeaderHasActions(widest, actions)).toBe(false)
  })

  test('are not drawn against a width or a measurement it cannot read', () => {
    expect(paneHeaderHasActions(Number.NaN, actions)).toBe(false)
    expect(paneHeaderHasActions(1000, Number.NaN)).toBe(false)
  })
})

describe('what a header field says', () => {
  test('writes DPR the way a preset does', () => {
    expect(formatDpr(3)).toBe('@3x')
    expect(formatDpr(1)).toBe('@1x')
  })

  test('counts errors the same way for every surface', () => {
    expect(describeErrors(1)).toBe('1 error')
    expect(describeErrors(3)).toBe('3 errors')
    expect(describeErrors(0)).toBe('0 errors')
  })

  test('gives every colour scheme a glyph, including system', () => {
    const glyphs = (['light', 'dark', 'system'] as const).map(schemeGlyph)
    expect(new Set(glyphs).size).toBe(3)
    expect(glyphs.every((glyph) => glyph.length > 0)).toBe(true)
  })

  test('calls a pane different from the app only when it renders the page differently', () => {
    expect(schemeDiffersFromApp('light', 'dark')).toBe(true)
    expect(schemeDiffersFromApp('dark', 'dark')).toBe(false)
    // System follows what the app already follows, so it is never the odd one out.
    expect(schemeDiffersFromApp('system', 'dark')).toBe(false)
    expect(schemeDiffersFromApp('system', 'light')).toBe(false)
  })
})

describe('a field against the emulation actually applied', () => {
  function statusWith(changes: Partial<PaneStatus>): PaneStatus {
    return { ...initialPaneStatus(), ...changes }
  }

  test('reads the capability that would make the field true', () => {
    const status = statusWith({
      emulation: { ...initialPaneStatus().emulation, viewport: 'failed' }
    })
    expect(paneFieldState(status, 'viewport')).toBe('failed')
    // DPR rides on the device metrics override, so it fails with the viewport.
    expect(paneFieldState(status, 'dpr')).toBe('failed')
    expect(paneFieldState(status, 'scheme')).toBe('pending')
  })

  test('reads as pending for a pane nothing is known about yet', () => {
    expect(paneFieldState(undefined, 'viewport')).toBe('pending')
  })

  test('fails the viewport when the pane is drawn at a size other than it declares', () => {
    const mismatched = foldPaneStatus(
      foldPaneStatus(initialPaneStatus(), {
        type: 'emulated',
        results: [{ capability: 'viewport', ok: true }]
      }),
      {
        type: 'geometryChecked',
        result: { ok: false, message: 'drawn 390×150, declared 390×844 at this zoom' }
      }
    )

    // CDP accepted the override; the host-side check says the pane is not that size, and
    // that is the one the header believes ([ADR-0004]).
    expect(mismatched.emulation.viewport).toBe('applied')
    expect(paneFieldState(mismatched, 'viewport')).toBe('failed')
    expect(paneFieldState(mismatched, 'dpr')).toBe('failed')
    expect(paneFieldState(mismatched, 'scheme')).toBe('pending')
  })

  test('says why a marked field is marked', () => {
    expect(describeFieldState('viewport', 'failed')).toBe('viewport declared but not emulated')
    expect(describeFieldState('scheme', 'applied')).toBe('colour scheme emulated as declared')
    expect(describeFieldState('dpr', 'pending')).toBe('DPR not yet emulated')
  })
})
