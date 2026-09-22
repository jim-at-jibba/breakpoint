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

export interface ThemeState {
  preference: ThemePreference
  /** The preference resolved against the OS: what the chrome is drawn as right now. */
  active: AppTheme
}

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

const THEME_PREFERENCES: ReadonlySet<string> = new Set<ThemePreference>(['system', 'light', 'dark'])

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.has(value)
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
