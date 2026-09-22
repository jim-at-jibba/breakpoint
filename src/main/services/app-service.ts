import { app, BrowserWindow } from 'electron'
import { DEFAULT_THEME_PREFERENCE, type AppTheme, type ThemeState } from '../../shared/theme'
import type { ThemePreference } from '../../shared/theme'
import { RouteError } from '../route-error'
import type { StateFeed } from '../state-feed'
import type { ThemeHost } from '../theme-host'
import type { SettingsStore } from './settings-store'

/**
 * The app itself, as a service. `app.*` routes are not one of the seven services in
 * PRD 8.1 — they act on the process rather than on panes, projects or logs — but they go
 * through a service all the same, so no adapter ever holds behaviour ([ADR-0005]).
 *
 * It owns the app theme, because the theme is the app's and not any project's: closing a
 * project does not close the developer's idea of what the tool looks like, and two
 * projects open one after the other do not disagree about it. The active theme leaves
 * here two ways and no others — in the snapshot every surface fetches, and in a patch
 * when it changes — so there is no second channel for a window to have to reconcile.
 *
 * It is not a pane's colour scheme and shares no code with one ([CONTEXT.md]).
 */
export class AppService {
  private preference: ThemePreference = DEFAULT_THEME_PREFERENCE
  private active: AppTheme = 'dark'
  /** What the feed has been told, so an OS event that changes nothing announces nothing. */
  private announced: ThemeState | undefined
  /** Why the stored settings could not be read, if they could not be. */
  private unreadable: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly createWindow: () => void,
    private readonly store: SettingsStore,
    private readonly feed: StateFeed,
    private readonly host: ThemeHost
  ) {}

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

  /**
   * Reads the stored preference once, at startup, and hands it to the platform.
   *
   * Called before the first window is created, which is what makes the launch flash
   * free: the window is given the right background colour when it is constructed, and
   * the renderer's `prefers-color-scheme` is already the app's by the time it loads.
   *
   * Settings this build will not read leave the theme following the OS, rather than
   * reporting a default the next save would make true.
   */
  async load(): Promise<void> {
    const loaded = await this.store.load()
    if (loaded.status === 'refused') {
      this.unreadable = `${this.store.file}: ${loaded.message}`
    } else if (loaded.status === 'loaded') {
      this.preference = loaded.settings.theme
    }
    this.active = this.host.apply(this.preference)
    this.announced = this.theme()
    // Subscribed after the first apply, so handing the platform the stored preference is
    // not itself reported as the developer changing the OS.
    this.host.onChanged(() => this.settle())
  }

  /** The preference and what it currently resolves to; what the snapshot carries. */
  theme(): ThemeState {
    return { preference: this.preference, active: this.active }
  }

  /**
   * Overrides the OS, or goes back to following it. Kept with the app's settings, so it
   * survives a restart, and never touches any pane: a dark app hosting a light pane is
   * the normal case.
   */
  setTheme(preference: ThemePreference): Promise<ThemeState> {
    return this.enqueue(async () => {
      if (preference !== this.preference) {
        this.requireReadable()
        // Saved first: a choice that could not be kept is not one the developer made.
        await this.store.save({ theme: preference })
        this.preference = preference
      }
      this.active = this.host.apply(preference)
      this.settle()
      return this.theme()
    })
  }

  /**
   * Takes the theme the platform now reports and announces it if anything a surface
   * draws has moved. Both paths land here: the developer choosing, and the OS changing
   * under a preference of `system`. Setting `themeSource` makes the platform announce a
   * change of its own, so this has to be safe to run twice for one decision.
   */
  private settle(): void {
    const state: ThemeState = { preference: this.preference, active: this.host.theme() }
    this.active = state.active
    const announced = this.announced
    if (announced?.preference === state.preference && announced.active === state.active) return
    this.announced = state
    this.host.paint(state.active)
    this.feed.publish({ type: 'app.theme', theme: state })
  }

  private requireReadable(): void {
    if (this.unreadable === undefined) return
    throw new RouteError('SETTINGS_UNREADABLE', this.unreadable, { file: this.store.file })
  }

  /** One at a time, in the order asked for, so a save can never land on a stale choice. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work)
    this.queue = done.then(
      () => undefined,
      () => undefined
    )
    return done
  }
}
