import type { RefusalReason } from './project'
import { DEFAULT_THEME_PREFERENCE, isThemePreference, type ThemePreference } from './theme'

/**
 * App settings: the choices that belong to the developer and this machine rather than to
 * any project. The app theme is the first of them ([#18]); density, the canvas grid and
 * the rest of PRD 8.2's Appearance panel join it here.
 *
 * A setting the file does not mention takes its default, so a file written by an older
 * build is read rather than refused. A setting it mentions wrongly is a corrupt file: a
 * value this build cannot make sense of is not a value to quietly replace.
 */

export const SETTINGS_FILE_VERSION = 1

export interface AppSettings {
  theme: ThemePreference
}

export interface SettingsFile extends AppSettings {
  version: number
}

export const DEFAULT_SETTINGS: AppSettings = { theme: DEFAULT_THEME_PREFERENCE }

export type ReadSettingsResult =
  { ok: true; settings: AppSettings } | { ok: false; reason: RefusalReason; message: string }

export function writeSettingsFile(settings: AppSettings): SettingsFile {
  return { version: SETTINGS_FILE_VERSION, theme: settings.theme }
}

export function readSettingsFile(raw: unknown): ReadSettingsResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return corrupt('the file is not a JSON object')
  }
  const file = raw as Record<string, unknown>
  if (!Number.isInteger(file.version)) return corrupt('the file has no integer version')
  if ((file.version as number) > SETTINGS_FILE_VERSION) {
    return {
      ok: false,
      reason: 'newer',
      message: `written by a newer Breakpoint (file version ${String(file.version)}, this build reads ${SETTINGS_FILE_VERSION})`
    }
  }

  // Absent is the default; present and unreadable is not.
  if (file.theme !== undefined && !isThemePreference(file.theme)) {
    return corrupt('theme must be system, light or dark')
  }
  return {
    ok: true,
    settings: { theme: isThemePreference(file.theme) ? file.theme : DEFAULT_SETTINGS.theme }
  }
}

function corrupt(message: string): ReadSettingsResult {
  return { ok: false, reason: 'corrupt', message }
}
