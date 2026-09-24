import { BrowserWindow, nativeTheme } from 'electron'
import { APP_THEME_BACKGROUND, type AppTheme } from '../shared/theme'

/**
 * The seam between the app theme and Electron, in the same spirit as `PaneHost`
 * ([ADR-0007]): everything the platform has to be asked or told lives behind this
 * interface, so the service that decides the theme is testable without a browser.
 *
 * **Nothing here sets `nativeTheme.themeSource`, and nothing ever may.** It is the
 * obvious way to implement an override and it is the wrong one: a pane whose colour
 * scheme is `system` emulates no override at all, so its page follows Chromium's native
 * theme — which `themeSource` *is*. Using it would make every default pane render the
 * page in the app's theme, which is precisely the code path the app theme and a pane's
 * colour scheme are not allowed to share ([CONTEXT.md], and the measured note in
 * `shared/emulation.ts`). So the platform is only ever read here, never set, and the
 * resolving is ours.
 *
 * The price is that Electron's own surfaces — native menus, dialogs — keep following the
 * desktop rather than an override. That is the right way round: they are the platform's
 * chrome, and no page renders inside them.
 */
export interface ThemeHost {
  /** What the desktop is set to now. Never an override: this is the OS being read. */
  systemTheme(): AppTheme
  /** Paints every open window; a window opened later takes its colour at construction. */
  paint(theme: AppTheme): void
  /** The desktop's appearance changed, which is a theme change while nothing overrides it. */
  onChanged(listener: () => void): void
}

export class NativeThemeHost implements ThemeHost {
  systemTheme(): AppTheme {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  paint(theme: AppTheme): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(APP_THEME_BACKGROUND[theme])
    }
  }

  /**
   * Never unsubscribed, deliberately: the app theme is the app's and outlives every
   * window, so there is no moment before the process ends at which it stops listening.
   */
  onChanged(listener: () => void): void {
    nativeTheme.on('updated', listener)
  }
}
