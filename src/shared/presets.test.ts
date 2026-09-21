import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANE_PRESETS,
  DEFAULT_PRESETS,
  paneFromPreset,
  paneFromSize,
  presetById,
  PRESET_FILE_VERSION,
  readPresetFile,
  writePresetFile,
  type Preset
} from './presets'

const mobile = presetById(DEFAULT_PRESETS, 'mobile')!

describe('the default presets', () => {
  it('ships the seven PRD 6.2 presets at their declared sizes', () => {
    expect(
      DEFAULT_PRESETS.map((preset) => [preset.id, preset.name, preset.width, preset.height])
    ).toEqual([
      ['mobileS', 'Mobile S', 360, 800],
      ['mobile', 'Mobile', 390, 844],
      ['mobileL', 'Mobile L', 430, 932],
      ['tablet', 'Tablet', 820, 1180],
      ['laptop', 'Laptop', 1280, 800],
      ['desktop', 'Desktop', 1440, 900],
      ['desktopL', 'Desktop L', 1920, 1080]
    ])
    expect(DEFAULT_PRESETS.map((preset) => preset.dpr)).toEqual([3, 3, 3, 2, 2, 1, 1])
  })

  it('sets the mobile flag and touch on the mobile and tablet presets only', () => {
    const touching = DEFAULT_PRESETS.filter((preset) => preset.touch).map((preset) => preset.id)
    expect(touching).toEqual(['mobileS', 'mobile', 'mobileL', 'tablet'])
    expect(DEFAULT_PRESETS.filter((preset) => preset.mobile).map((preset) => preset.id)).toEqual(
      touching
    )
  })

  it('carries no user agent of its own, so a pane claims the Chromium that is rendering it', () => {
    for (const preset of DEFAULT_PRESETS) expect(preset.userAgent).toBeNull()
  })

  it('names the three a new project starts with', () => {
    expect(DEFAULT_PANE_PRESETS).toEqual(['mobile', 'tablet', 'desktop'])
    for (const id of DEFAULT_PANE_PRESETS) expect(presetById(DEFAULT_PRESETS, id)).toBeDefined()
  })
})

describe('paneFromPreset', () => {
  it('resolves the preset into values the pane owns, remembering only its id', () => {
    expect(paneFromPreset(mobile)).toEqual({
      name: 'Mobile',
      width: 390,
      height: 844,
      dpr: 3,
      mobile: true,
      touch: true,
      userAgent: null,
      colorScheme: 'system',
      preset: 'mobile'
    })
  })

  it('takes a preset that carries a user agent at its word', () => {
    const kiosk: Preset = { ...mobile, id: 'kiosk', name: 'Kiosk', userAgent: 'Kiosk/1.0' }
    expect(paneFromPreset(kiosk).userAgent).toBe('Kiosk/1.0')
  })

  /** [ADR-0011]: the snapshot is taken once, so editing the preset afterwards is not felt. */
  it('is a snapshot, not a reference: editing the preset afterwards changes nothing resolved', () => {
    const preset: Preset = { ...mobile }
    const pane = paneFromPreset(preset)

    preset.width = 1
    preset.name = 'Renamed'

    expect(pane.width).toBe(390)
    expect(pane.name).toBe('Mobile')
  })
})

describe('paneFromSize', () => {
  it('resolves a custom size into a desktop-shaped pane belonging to no preset', () => {
    expect(paneFromSize({ width: 1024, height: 768 })).toEqual({
      name: '1024×768',
      width: 1024,
      height: 768,
      dpr: 1,
      mobile: false,
      touch: false,
      userAgent: null,
      colorScheme: 'system',
      preset: null
    })
  })
})

describe('presetById', () => {
  it('finds a preset by id and answers for one that is not there', () => {
    expect(presetById(DEFAULT_PRESETS, 'tablet')?.name).toBe('Tablet')
    expect(presetById(DEFAULT_PRESETS, 'watch')).toBeUndefined()
  })
})

describe('readPresetFile', () => {
  it('reads a file written by this build back as the presets it holds', () => {
    const raw = JSON.parse(JSON.stringify(writePresetFile(DEFAULT_PRESETS)))
    expect(readPresetFile(raw)).toEqual({ ok: true, presets: [...DEFAULT_PRESETS] })
  })

  it('refuses a file written by a newer build rather than guessing at its fields', () => {
    const raw = { ...writePresetFile(DEFAULT_PRESETS), version: PRESET_FILE_VERSION + 1 }
    expect(readPresetFile(raw)).toMatchObject({ ok: false, reason: 'newer' })
  })

  it.each([
    ['not an object', 42],
    ['no version', { presets: [] }],
    ['no presets', { version: PRESET_FILE_VERSION }],
    ['a preset with no id', { version: PRESET_FILE_VERSION, presets: [{ ...mobile, id: 7 }] }],
    [
      'a preset with a string width',
      { version: PRESET_FILE_VERSION, presets: [{ ...mobile, width: '390' }] }
    ],
    [
      'a preset wider than a pane may be',
      { version: PRESET_FILE_VERSION, presets: [{ ...mobile, width: 1_000_000 }] }
    ],
    [
      'a preset with a numeric user agent',
      { version: PRESET_FILE_VERSION, presets: [{ ...mobile, userAgent: 7 }] }
    ],
    [
      'two presets sharing an id',
      { version: PRESET_FILE_VERSION, presets: [mobile, { ...mobile, name: 'Other' }] }
    ]
  ])('refuses a corrupt file: %s', (_label, raw) => {
    expect(readPresetFile(raw)).toMatchObject({ ok: false, reason: 'corrupt' })
  })

  it('names the preset it refused and every field of it that is wrong', () => {
    const noTouch: Record<string, unknown> = { ...mobile }
    delete noTouch.touch
    expect(readPresetFile({ version: PRESET_FILE_VERSION, presets: [noTouch] })).toEqual({
      ok: false,
      reason: 'corrupt',
      message: 'preset mobile (touch) is not a preset'
    })
    expect(
      readPresetFile({
        version: PRESET_FILE_VERSION,
        presets: [{ ...mobile, width: '390', dpr: 0 }]
      })
    ).toMatchObject({ message: 'preset mobile (width, dpr) is not a preset' })
  })

  it('numbers an entry that has no id to name it by', () => {
    expect(
      readPresetFile({ version: PRESET_FILE_VERSION, presets: [mobile, { name: 'Watch' }] })
    ).toMatchObject({ message: expect.stringContaining('preset 2 (id, width') })
  })

  it('copies only the known fields out, so an edited file cannot smuggle one in', () => {
    const raw = {
      version: PRESET_FILE_VERSION,
      presets: [{ ...mobile, extra: 'ignored' }]
    }
    expect(readPresetFile(raw)).toEqual({ ok: true, presets: [mobile] })
  })
})
