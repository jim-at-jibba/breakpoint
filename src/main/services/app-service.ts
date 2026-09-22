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

  /**
   * Brings the existing window forward. `app.focus` as well as the window's own: on
   * macOS a window can be raised without its application being the one in front, and a
   * developer told to look at Breakpoint should be looking at Breakpoint.
   *
   * `focused` is false when there was no window to raise, which is not a failure — the
   * caller that cares, the launch path, opens one instead.
   */
  focus(): { focused: boolean } {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return { focused: false }
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    app.focus({ steal: true })
    return { focused: true }
  }
}
