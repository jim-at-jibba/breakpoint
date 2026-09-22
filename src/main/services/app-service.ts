import { app, BrowserWindow } from 'electron'

/**
 * The app itself, as a service. `app.*` routes are not one of the seven services in
 * PRD 8.1 — they act on the process rather than on panes, projects or logs — but they go
 * through a service all the same, so no adapter ever holds behaviour ([ADR-0005]).
 */
export class AppService {
  constructor(private readonly createWindow: () => void) {}

  quit(): void {
    app.quit()
  }

  /**
   * Brings the existing window forward. `app.focus` as well as the window's own: on
   * macOS a window can be raised without its application being the one in front, and a
   * developer told to look at Breakpoint should be looking at Breakpoint.
   *
   * The app remains alive without a window on macOS, so focusing also ensures there is
   * a window to show. Its ready-to-show path performs the eventual activation.
   */
  focus(): { focused: true } {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) {
      this.createWindow()
      return { focused: true }
    }
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    app.focus({ steal: true })
    return { focused: true }
  }
}
