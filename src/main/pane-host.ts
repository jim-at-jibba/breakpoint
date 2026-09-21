import type { App, WebContents, WebPreferences } from 'electron'
import { PANE_PREFERENCE, paneIdFromPreferences } from '../shared/panes'
import type { PaneService } from './services/pane-service'

/**
 * `PaneHost` owns a pane's Electron side: letting its `<webview>` attach, forcing the
 * guest's security, binding the guest to its pane, making the attachment, and handing
 * back the `webContents`. It is a seam, not an interface ([ADR-0007]) — there is one
 * host, and the other one Electron offers would yield an ordinary `webContents` too.
 *
 * Pane content has no IPC channel: everything the app learns about a page arrives over
 * the attachment, which the page cannot see or spoof. What the host observes it reports
 * to the pane service by pane id.
 */

/** The app window's preferences for hosting panes. The tag is enabled here and nowhere else. */
export const HOST_WINDOW_PREFERENCES = { webviewTag: true } as const satisfies WebPreferences

/** The protocol version `webContents.debugger` speaks. */
const CDP_VERSION = '1.3'

/** Chromium's code for a load that was superseded rather than failed. */
const ERR_ABORTED = -3

interface PendingGuest {
  pane: string
  src: string
}

export class PaneHost {
  private readonly hosts = new WeakSet<WebContents>()
  private readonly guests = new Map<string, WebContents>()
  private pending: PendingGuest | null = null

  constructor(private readonly panes: PaneService) {}

  /**
   * Installs the guards every web contents gets, whether or not it hosts panes. Call once,
   * before any window exists.
   */
  install(app: App): void {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') {
        // Before anything else can run in it: `window.open` and `target=_blank` never
        // spawn a window, whatever the page or the element asked for.
        contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      }
      contents.on('will-attach-webview', (event, preferences, params) => {
        if (!this.hosts.has(contents)) {
          event.preventDefault()
          return
        }
        this.willAttach(event, preferences, params)
      })
      contents.on('did-attach-webview', (_attached, guest) => {
        if (this.hosts.has(contents)) this.didAttach(guest)
      })
    })
  }

  /** Lets a window's web contents host panes. Only the app window is ever adopted. */
  adopt(host: WebContents): void {
    this.hosts.add(host)
  }

  /** The pane's guest, for whatever needs to act on the page over its attachment. */
  webContentsFor(pane: string): WebContents | undefined {
    return this.guests.get(pane)
  }

  /**
   * Overwritten, never validated: what the renderer asked for is irrelevant, because
   * any answer other than these is wrong. A guest for no pane of the open project is
   * refused outright.
   */
  private willAttach(
    event: Electron.Event,
    preferences: WebPreferences,
    params: Record<string, string>
  ): void {
    // A guest refused after this point never reaches `did-attach-webview`, so a slot
    // left over from it must not be read as the next guest's pane.
    this.pending = null
    const pane = paneIdFromPreferences(preferences as Record<string, unknown>)
    const writable = preferences as Record<string, unknown>
    delete writable[PANE_PREFERENCE]
    delete preferences.preload
    preferences.sandbox = true
    preferences.contextIsolation = true
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.nodeIntegrationInWorker = false
    preferences.webviewTag = false

    if (pane === null || !this.panes.has(pane)) {
      event.preventDefault()
      return
    }
    // `did-attach-webview` for this guest fires in this same task, before any other
    // guest's `will-attach-webview` can, so one slot is enough to carry the pane across.
    this.pending = { pane, src: params.src ?? '' }
  }

  private didAttach(guest: WebContents): void {
    const pending = this.pending
    this.pending = null
    if (!pending) {
      // Cannot happen while the two events stay paired; if they ever stop being, an
      // unbound guest is closed rather than left running outside every rule here.
      guest.close()
      return
    }
    this.bind(pending.pane, guest, pending.src)
  }

  private bind(pane: string, guest: WebContents, src: string): void {
    this.guests.set(pane, guest)
    const current = (): boolean => this.isCurrent(pane, guest)

    // Listeners before the attachment, so a refused attachment cannot cost the pane
    // its lifecycle (#4).
    guest.on('did-finish-load', () => {
      if (current()) this.panes.loaded(pane, guest.getURL())
    })
    guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED && current()) {
        this.panes.loadFailed(pane, url, code, description)
      }
    })
    guest.once('destroyed', () => {
      const wasCurrent = current()
      if (wasCurrent) this.guests.delete(pane)
      this.panes.guestDestroyed(pane, wasCurrent)
    })

    this.panes.guestCreated(pane, src)
    this.attach(pane, guest, 1)
  }

  /** Whether `guest` is still the pane's, rather than one it has since replaced. */
  private isCurrent(pane: string, guest: WebContents): boolean {
    return this.guests.get(pane) === guest
  }

  /**
   * Attachment failure never fails the pane: it renders, degraded, with the reason
   * recorded. One retry once the page has loaded, then stop — no backoff loop.
   */
  private attach(pane: string, guest: WebContents, attempt: 1 | 2): void {
    try {
      guest.debugger.attach(CDP_VERSION)
    } catch (error) {
      const retrying = attempt === 1
      const message = error instanceof Error ? error.message : String(error)
      this.panes.attachFailed(pane, attempt, retrying, message)
      if (retrying) {
        guest.once('did-stop-loading', () => {
          if (!guest.isDestroyed() && this.isCurrent(pane, guest)) this.attach(pane, guest, 2)
        })
      }
      return
    }
    this.panes.attached(pane, attempt)
  }
}
