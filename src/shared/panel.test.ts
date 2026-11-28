import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyPanelSetting,
  CANVAS_MIN_SIZE,
  DEFAULT_PANEL,
  DEFAULT_PANEL_SIZES,
  PANEL_MIN_SIZE,
  panelSize,
  readPanel,
  samePanel,
  type PanelState
} from './panel'

describe('arranging the panel', () => {
  it('starts docked below the canvas, showing, at the prototype sizes', () => {
    expect(DEFAULT_PANEL).toEqual({
      side: 'bottom',
      visible: true,
      sizes: { bottom: 278, right: 460 }
    })
    expect(panelSize(DEFAULT_PANEL)).toBe(278)
  })

  it('keeps a size per side, so docking away and back returns it to its size there', () => {
    const resized = applyPanelSetting(DEFAULT_PANEL, { size: 320 })
    const beside = applyPanelSetting(resized, { side: 'right' })
    const back = applyPanelSetting(beside, { side: 'bottom' })

    expect(panelSize(beside)).toBe(460)
    expect(panelSize(back)).toBe(320)
  })

  it('applies a size to the side it docks to in the same setting', () => {
    const moved = applyPanelSetting(DEFAULT_PANEL, { side: 'right', size: 500 })

    expect(moved.sizes).toEqual({ bottom: 278, right: 500 })
  })

  it('hides and shows without forgetting where it was or how big', () => {
    const hidden = applyPanelSetting(DEFAULT_PANEL, { visible: false })
    const shown = applyPanelSetting(hidden, { visible: true })

    expect(hidden).toEqual({ ...DEFAULT_PANEL, visible: false })
    expect(samePanel(shown, DEFAULT_PANEL)).toBe(true)
  })

  it('keeps sizes whole and never smaller than its tab bar', () => {
    expect(panelSize(applyPanelSetting(DEFAULT_PANEL, { size: 300.6 }))).toBe(301)
    expect(panelSize(applyPanelSetting(DEFAULT_PANEL, { size: 4 }))).toBe(PANEL_MIN_SIZE)
  })

  it('tells a change from no change', () => {
    const moved: PanelState = { ...DEFAULT_PANEL, sizes: { ...DEFAULT_PANEL.sizes, right: 461 } }

    expect(samePanel(DEFAULT_PANEL, { ...DEFAULT_PANEL, sizes: { ...DEFAULT_PANEL.sizes } })).toBe(
      true
    )
    expect(samePanel(DEFAULT_PANEL, moved)).toBe(false)
  })
})

describe('reading the panel from settings', () => {
  it('defaults a panel the file does not mention', () => {
    expect(readPanel(undefined)).toEqual({ ok: true, panel: DEFAULT_PANEL })
  })

  it('clamps a stored size too small to find again, rather than refusing the file', () => {
    expect(readPanel({ sizes: { bottom: 2 } })).toMatchObject({
      ok: true,
      panel: { sizes: { bottom: PANEL_MIN_SIZE } }
    })
  })

  it.each([
    ['visible that is not a boolean', { visible: 'yes' }],
    ['sizes that are not an object', { sizes: [278] }],
    ['a negative size', { sizes: { right: -1 } }],
    ['a size that is not finite', { sizes: { right: Infinity } }]
  ])('refuses %s', (_what, raw) => {
    expect(readPanel(raw)).toMatchObject({ ok: false })
  })
})

/**
 * The defaults and the bounds are numbers here because a setting has to have a value
 * before any stylesheet is read, but they are the design prototype's tokens all the
 * same. Both stylesheets are read, so the setting drifting from either is a failure here.
 */
describe('the panel and the design tokens', () => {
  const stylesheets = {
    'the design prototype': '../../docs/design/breakpoint-prototype/globals.css',
    'the renderer': '../renderer/src/index.css'
  } as const

  const tokens = {
    '--bp-panel-h': DEFAULT_PANEL_SIZES.bottom,
    '--bp-panel-w': DEFAULT_PANEL_SIZES.right,
    '--bp-tabbar-h': PANEL_MIN_SIZE,
    '--bp-canvas-min': CANVAS_MIN_SIZE
  } as const

  it.each(
    Object.entries(stylesheets).flatMap(([where, path]) =>
      Object.entries(tokens).map(([token, px]) => [where, path, token, px] as const)
    )
  )('agree with %s on %s', (_where, path, token, px) => {
    const css = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    const declared = new RegExp(`${token}:\\s*([^;]+);`).exec(css)
    expect(declared, `${token} is declared`).not.toBeNull()
    expect(declared![1].trim()).toBe(`${px}px`)
  })
})
