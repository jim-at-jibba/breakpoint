import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  readSettingsFile,
  SETTINGS_FILE_VERSION,
  writeSettingsFile
} from './settings'

describe('reading the settings file', () => {
  it('round-trips what was written', () => {
    const written = writeSettingsFile({ theme: 'light' })

    expect(written).toEqual({ version: SETTINGS_FILE_VERSION, theme: 'light' })
    expect(readSettingsFile(written)).toEqual({ ok: true, settings: { theme: 'light' } })
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

    expect(read).toEqual({ ok: true, settings: { theme: 'dark' } })
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
    ['a theme that is not a string', { version: SETTINGS_FILE_VERSION, theme: 1 }]
  ])('refuses a file with %s', (_what, raw) => {
    expect(readSettingsFile(raw)).toMatchObject({ ok: false, reason: 'corrupt' })
  })
})
