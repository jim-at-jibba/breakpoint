import { app, BrowserWindow } from 'electron'
import {
  DEFAULT_THEME_PREFERENCE,
  resolveThemeState,
  type AppTheme,
  type ThemePreference,
  type ThemeState
} from '../../shared/theme'
import type { SwitcherState } from '../../shared/state'
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
 *
 * It owns whether the project switcher is showing for the same reason: the switcher is
 * the way into a project, so it cannot belong to the project that is open ([ADR-0016]).
 */
export class AppService {
  /**
   * Whether the project switcher is showing. Here and not in the renderer because the
   * shortcut that opens it is a menu accelerator, which fires in this process
   * ([ADR-0016]); it is the app's and not a project's for the same reason the theme is.
   *
   * Never stored. A switcher left open when the app quit is not a preference, and a
   * window that came up with it already over the canvas would be answering a question
   * nobody has asked yet.
   */
  private switcherOpen = false
  private preference: ThemePreference = DEFAULT_THEME_PREFERENCE
  private system: AppTheme = 'dark'
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

  /** Whether the switcher is showing; what the snapshot carries. */
  switcher(): SwitcherState {
    return { open: this.switcherOpen }
  }

  /**
   * Shows or hides the project switcher, from whichever surface asked: the menu
   * accelerator, the toolbar button, or Escape. Silent when it did not move, so a held
   * shortcut is not a patch per repeat and a second Escape announces nothing.
   *
   * Not queued and not stored — nothing is written, so there is no save for a later call
   * to land behind.
   */
  setSwitcher(open: boolean): SwitcherState {
    if (open !== this.switcherOpen) {
      this.switcherOpen = open
      this.feed.publish({ type: 'app.switcher', switcher: this.switcher() })
    }
    return this.switcher()
  }

  /**
   * Reads the stored preference once, at startup, and resolves it against the desktop.
   *
   * Called before the first window is created, which is what makes the launch flash
   * free: the window is given the right background colour when it is constructed, rather
   * than being painted the other theme and corrected once a renderer has something to
   * say.
   *
   * Settings this build will not read leave the theme following the desktop, rather than
   * reporting a default the next save would make true.
   */
  async load(): Promise<void> {
    const loaded = await this.store.load()
    if (loaded.status === 'refused') {
      this.unreadable = `${this.store.file}: ${loaded.message}`
    } else if (loaded.status === 'loaded') {
      this.preference = loaded.settings.theme
    }
    this.system = this.host.systemTheme()
    this.announced = this.theme()
    this.host.onChanged(() => this.announce())
  }

  /** The preference and what it currently resolves to; what the snapshot carries. */
  theme(): ThemeState {
    return resolveThemeState(this.preference, this.system)
  }

  /**
   * Overrides the OS, or goes back to following it. Kept with the app's settings, so it
   * survives a restart, and never touches any pane: a dark app hosting a light pane is
   * the normal case.
   */
  setTheme(preference: ThemePreference): Promise<ThemeState> {
    return this.enqueue(async () => {
      // Asked before the comparison, not after: a settings file this build will not read
      // makes every choice unkeepable, and answering "yes" to the one that happens to be
      // the current preference would make the refusal depend on what was already set.
      this.requireReadable()
      if (preference !== this.preference) {
        // Saved first: a choice that could not be kept is not one the developer made.
        await this.store.save({ theme: preference })
        this.preference = preference
      }
      this.announce()
      return this.theme()
    })
  }

  /**
   * Resolves the preference against the desktop, and tells everyone that draws the
   * chrome if anything moved — the open windows, which carry the colour a renderer has
   * not painted yet, and the feed, which carries it to every surface.
   *
   * Both paths land here: the developer choosing, and the desktop changing under a
   * preference of `system`. Silent when nothing moved, so a desktop that announces an
   * appearance the app already has is not a patch every surface has to fold in.
   */
  private announce(): void {
    this.system = this.host.systemTheme()
    const state = this.theme()
    const announced = this.announced
    if (
      announced?.preference === state.preference &&
      announced.active === state.active &&
      announced.system === state.system
    ) {
      return
    }
    this.announced = state
    if (announced?.active !== state.active) this.host.paint(state.active)
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
