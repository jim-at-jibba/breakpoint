import { describe, expect, it } from 'vitest'
import { DEFAULT_PANEL, type PanelState } from './panel'
import {
  DEFAULT_SETTINGS,
  readSettingsFile,
  SETTINGS_FILE_VERSION,
  writeSettingsFile
} from './settings'

describe('reading the settings file', () => {
  it('round-trips what was written', () => {
    const panel: PanelState = { side: 'right', visible: false, sizes: { bottom: 200, right: 512 } }
    const written = writeSettingsFile({ theme: 'light', panel })

    expect(written).toEqual({ version: SETTINGS_FILE_VERSION, theme: 'light', panel })
    expect(readSettingsFile(written)).toEqual({ ok: true, settings: { theme: 'light', panel } })
  })

  it('defaults a setting the file does not mention', () => {
    expect(readSettingsFile({ version: SETTINGS_FILE_VERSION })).toEqual({
      ok: true,
      settings: DEFAULT_SETTINGS
    })
  })

  it('keeps the settings it knows and ignores the ones it does not', () => {
    const read = readSettingsFile({
      version: SETTINGS_FILE_VERSION,
      theme: 'dark',
      density: 'roomy'
    })

    expect(read).toEqual({ ok: true, settings: { theme: 'dark', panel: DEFAULT_PANEL } })
  })

  it('refuses a file written by a newer Breakpoint rather than reading past it', () => {
    const read = readSettingsFile({ version: SETTINGS_FILE_VERSION + 1, theme: 'light' })

    expect(read).toMatchObject({ ok: false, reason: 'newer' })
  })

  it.each([
    ['not an object', []],
    ['no version', { theme: 'light' }],
    ['a version that is not a whole number', { version: 1.5, theme: 'light' }],
    ['a theme that is not one of the three', { version: SETTINGS_FILE_VERSION, theme: 'auto' }],
    ['a theme that is not a string', { version: SETTINGS_FILE_VERSION, theme: 1 }],
    ['a panel that is not an object', { version: SETTINGS_FILE_VERSION, panel: 'bottom' }],
    [
      'a panel docked to a side it has not got',
      { version: SETTINGS_FILE_VERSION, panel: { side: 'left' } }
    ],
    [
      'a panel size that is not a number',
      { version: SETTINGS_FILE_VERSION, panel: { sizes: { bottom: '278px' } } }
    ]
  ])('refuses a file with %s', (_what, raw) => {
    expect(readSettingsFile(raw)).toMatchObject({ ok: false, reason: 'corrupt' })
  })
})

describe('the panel in the settings file', () => {
  it('reads a file from before the panel was a setting as the default arrangement', () => {
    expect(readSettingsFile({ version: SETTINGS_FILE_VERSION, theme: 'dark' })).toEqual({
      ok: true,
      settings: { theme: 'dark', panel: DEFAULT_PANEL }
    })
  })

  it('defaults each part of the panel the file does not mention', () => {
    expect(
      readSettingsFile({ version: SETTINGS_FILE_VERSION, panel: { sizes: { right: 600 } } })
    ).toEqual({
      ok: true,
      settings: {
        theme: DEFAULT_SETTINGS.theme,
        panel: { ...DEFAULT_PANEL, sizes: { ...DEFAULT_PANEL.sizes, right: 600 } }
      }
    })
  })
})
