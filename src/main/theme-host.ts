import { BrowserWindow, nativeTheme } from 'electron'
import { APP_THEME_BACKGROUND, type AppTheme, type ThemePreference } from '../shared/theme'

/**
 * The seam between the app theme and Electron, in the same spirit as `PaneHost`
 * ([ADR-0007]): everything Chromium and the platform have to be told lives behind this
 * interface, so the service that decides the theme can be tested without a browser.
 *
 * Only three things outside the renderer care, and they are the three methods:
 *
 * - `themeSource` is the platform's own switch. Setting it makes Electron's menus,
 *   scrollbars and dialogs follow, and makes `prefers-color-scheme` in every renderer
 *   follow with them.
 * - a window's background colour is what is on screen from the moment the window exists
 *   until its renderer has painted, which is the whole of the no-flash requirement.
 * - the OS appearance can change while the app is running, and with the preference on
 *   `system` that is a theme change.
 */
export interface ThemeHost {
  /** Hands the preference to the platform, and answers with the theme that results. */
  apply(preference: ThemePreference): AppTheme
  /** The theme now, without changing anything. */
  theme(): AppTheme
  /** Paints every window, including ones opened later, through `createWindow`. */
  paint(theme: AppTheme): void
  /** The platform's appearance changed. Returns its own unsubscribe. */
  onChanged(listener: () => void): () => void
}

export class NativeThemeHost implements ThemeHost {
  apply(preference: ThemePreference): AppTheme {
    nativeTheme.themeSource = preference
    return this.theme()
  }

  theme(): AppTheme {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  paint(theme: AppTheme): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(APP_THEME_BACKGROUND[theme])
    }
  }

  onChanged(listener: () => void): () => void {
    nativeTheme.on('updated', listener)
    return () => nativeTheme.off('updated', listener)
  }
}
