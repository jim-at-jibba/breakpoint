import { useLayoutEffect } from 'react'
import type { AppTheme } from '../../../shared/theme'

/**
 * Draws the app theme, by putting its class on `<html>` — which is what the `.light` and
 * `.dark` token layers in `index.css` are keyed on.
 *
 * The snapshot is where the theme comes from, and `null` is the moment before the first
 * one has arrived. No class is put on in that moment and none is guessed at: the window's
 * own background colour is already the right one, the document is transparent until a
 * class lands (`index.css`), and the app draws nothing over it (`App.tsx`). So the
 * handover is invisible, and there is no second answer to what the theme is that could
 * disagree with the snapshot's.
 *
 * `prefers-color-scheme` is specifically not that second answer. Breakpoint never
 * overrides Chromium's native theme, because a pane emulating no colour scheme follows
 * it ([theme-host.ts]) — so in this window it reports the desktop, not the app.
 *
 * Laid out rather than merely effected, so the class is on before the first frame the
 * developer sees rather than one frame after it.
 */
export function useAppTheme(theme: AppTheme | null): void {
  useLayoutEffect(() => {
    if (theme === null) return
    const html = document.documentElement
    html.classList.toggle('dark', theme === 'dark')
    html.classList.toggle('light', theme === 'light')
  }, [theme])
}
