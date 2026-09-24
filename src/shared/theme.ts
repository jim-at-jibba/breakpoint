/**
 * App theme: whether Breakpoint's own chrome is light or dark ([CONTEXT.md]).
 *
 * Deliberately not a pane's `ColorScheme`, which spells two of its values the same way
 * and means something else. A pane's colour scheme is emulation applied to a page we do
 * not own; the app theme is the chrome we do. Sharing the type would be the first step
 * towards sharing a code path, and a dark app hosting a light pane is the normal case
 * rather than an edge one.
 */

/** What the chrome can actually be. Two values, because there is no third appearance. */
export type AppTheme = 'light' | 'dark'

/**
 * What the developer chose. `system` is the default and follows the OS; the other two
 * are the override, for a developer who wants the tool dark on a light desktop.
 */
export type ThemePreference = 'system' | AppTheme

/**
 * The app preference, the desktop underneath it, and the resulting chrome. Written as a
 * union so an override can never claim to have resolved to the opposite appearance.
 */
export type ThemeState =
  | { preference: 'system'; system: 'light'; active: 'light' }
  | { preference: 'system'; system: 'dark'; active: 'dark' }
  | { preference: 'light'; system: AppTheme; active: 'light' }
  | { preference: 'dark'; system: AppTheme; active: 'dark' }

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

const THEME_PREFERENCES: ReadonlySet<string> = new Set<ThemePreference>(['system', 'light', 'dark'])

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.has(value)
}

/**
 * The preference against what the desktop is set to. The whole of the override: an
 * override is the answer, and `system` is the desktop's.
 *
 * Breakpoint resolves this itself rather than handing the preference to
 * `nativeTheme.themeSource` and reading back what Chromium made of it. Chromium's native
 * theme is what a pane emulating no colour scheme follows, so overriding it would put
 * the app theme inside every default pane's page ([theme-host.ts]).
 */
export function resolveAppTheme(preference: ThemePreference, system: AppTheme): AppTheme {
  return preference === 'system' ? system : preference
}

/** Builds a state whose active appearance is constrained by its preference. */
export function resolveThemeState(preference: ThemePreference, system: AppTheme): ThemeState {
  if (preference === 'system') {
    return system === 'light'
      ? { preference, system, active: 'light' }
      : { preference, system, active: 'dark' }
  }
  return preference === 'light'
    ? { preference, system, active: 'light' }
    : { preference, system, active: 'dark' }
}

/**
 * The window's own background colour per theme.
 *
 * This is what is on screen from the moment the window exists until the renderer has
 * painted anything, so it is the difference between a launch that flashes and one that
 * does not. A `BrowserWindow` takes a colour rather than a token, which is why the two
 * values are spelled out here — they are `--bp-chrome` in each theme, from the design
 * prototype's `globals.css`. This is the one place they are written as hex, and the one
 * place to change if the token moves.
 */
export const APP_THEME_BACKGROUND: Record<AppTheme, string> = {
  dark: '#191b28',
  light: '#eceef5'
}
