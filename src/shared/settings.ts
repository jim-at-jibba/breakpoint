import {
  DEFAULT_CONSOLE_SETTINGS,
  readConsoleSettings,
  type ConsoleSettings
} from './console-floor'
import { DEFAULT_PANEL, readPanel, type PanelState } from './panel'
import type { RefusalReason } from './project'
import { DEFAULT_THEME_PREFERENCE, isThemePreference, type ThemePreference } from './theme'

/**
 * App settings: the choices that belong to the developer and this machine rather than to
 * any project. The app theme is the first of them ([#18]) and the panel's arrangement
 * the second ([#73]), the Console's preserve-log the third ([#77]); density, the canvas grid and the rest of PRD 8.2's Appearance panel
 * join them here.
 *
 * A setting the file does not mention takes its default, so a file written by an older
 * build is read rather than refused. A setting it mentions wrongly is a corrupt file: a
 * value this build cannot make sense of is not a value to quietly replace.
 */

export const SETTINGS_FILE_VERSION = 1

export interface AppSettings {
  /**
   * The app theme the developer chose, which is a preference and not an appearance:
   * `system` is a setting, and what it resolves to is `ThemeState.active` rather than
   * anything stored. Spelled `theme` on disk because that is what a developer editing
   * this file by hand would look for.
   */
  theme: ThemePreference
  /**
   * Where the panel docks, how big it is on each side, and whether it is showing. Here
   * rather than in the project, because a panel arrangement is how a developer works and
   * not a property of a repo: switching repos never rearranges the window.
   */
  panel: PanelState
  /**
   * Whether the Console keeps its entries when the project navigates ([ADR-0022]). How a
   * developer reads, not a property of a repo, so it is the app's like the panel. The
   * display floor itself is not stored: the log it points into does not outlive a run.
   */
  console: ConsoleSettings
}

export interface SettingsFile extends AppSettings {
  version: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: DEFAULT_THEME_PREFERENCE,
  panel: DEFAULT_PANEL,
  console: DEFAULT_CONSOLE_SETTINGS
}

export type ReadSettingsResult =
  { ok: true; settings: AppSettings } | { ok: false; reason: RefusalReason; message: string }

export function writeSettingsFile(settings: AppSettings): SettingsFile {
  return {
    version: SETTINGS_FILE_VERSION,
    theme: settings.theme,
    panel: settings.panel,
    console: settings.console
  }
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
  const panel = readPanel(file.panel)
  if (!panel.ok) return corrupt(panel.message)
  const consoleSettings = readConsoleSettings(file.console)
  if (!consoleSettings.ok) return corrupt(consoleSettings.message)
  return {
    ok: true,
    settings: {
      theme: isThemePreference(file.theme) ? file.theme : DEFAULT_SETTINGS.theme,
      panel: panel.panel,
      console: consoleSettings.console
    }
  }
}

function corrupt(message: string): ReadSettingsResult {
  return { ok: false, reason: 'corrupt', message }
}
