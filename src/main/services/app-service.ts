import { app, BrowserWindow } from 'electron'

/**
 * The app itself, as a service. `app.*` routes are not one of the seven services in
 * PRD 8.1 — they act on the process rather than on panes, projects or logs — but they go
 * through a service all the same, so no adapter ever holds behaviour ([ADR-0005]).
 */
export class AppService {
  quit(): void {
    app.quit()
  }

  /** Whether there was a window to bring forward. Nothing to raise is not a failure. */
  focus(): { focused: boolean } {
    return { focused: focusWindow() }
  }
}

/**
 * Brings the existing window forward, or says there is none. `app.focus` as well as the
 * window's own: on macOS a window can be raised without its application being the one in
 * front, and a developer told to look at Breakpoint should be looking at Breakpoint.
 */
export function focusWindow(): boolean {
  const [existing] = BrowserWindow.getAllWindows()
  if (!existing) return false
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
  app.focus({ steal: true })
  return true
}
