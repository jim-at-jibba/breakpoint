import { useLayoutEffect } from 'react'
import type { AppTheme } from '../../../shared/theme'

/**
 * Draws the app theme, by putting its class on `<html>` — which is what the `.light` and
 * `.dark` token layers in `index.css` are keyed on.
 *
 * The snapshot is where the theme comes from, and `null` is the moment before the first
 * one has arrived. The chrome still has to be drawn in that moment, so it falls back to
 * what the window itself reports: the main process handed the stored preference to
 * `nativeTheme` before this window was created, and `prefers-color-scheme` here is that
 * preference resolved. It is the platform answering, not a second channel for the theme,
 * and it agrees with the snapshot that replaces it.
 *
 * Laid out rather than merely effected, so the class is on before the first frame the
 * developer sees rather than one frame after it.
 *
 * Nothing here touches a pane: a pane's colour scheme is emulation, applied to its own
 * guest over the attachment, and a dark app hosting a light pane is the normal case.
 */
export function useAppTheme(theme: AppTheme | null): void {
  useLayoutEffect(() => {
    const drawn = theme ?? windowTheme()
    const html = document.documentElement
    html.classList.toggle('dark', drawn === 'dark')
    html.classList.toggle('light', drawn === 'light')
  }, [theme])
}

function windowTheme(): AppTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
