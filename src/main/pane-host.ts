import type { App, LoadURLOptions, Session, WebContents, WebPreferences } from 'electron'
import { applyEmulation, emulationFor } from '../shared/emulation'
import { PANE_PREFERENCE, paneIdFromPreferences } from '../shared/panes'
import { isWebUrl } from '../shared/urls'
import type { PaneService } from './services/pane-service'
import type { StateFeed } from './state-feed'

/**
 * `PaneHost` owns a pane's Electron side: letting its `<webview>` attach, forcing the
 * guest's security, binding the guest to its pane, making the attachment, and handing
 * back the `webContents`. It is a seam, not an interface ([ADR-0007]) — there is one
 * host, and the other one Electron offers would yield an ordinary `webContents` too.
 *
 * Pane content has no IPC channel: everything the app learns about a page arrives over
 * the attachment, which the page cannot see or spoof. What the host observes it reports
 * to the pane service by pane id.
 *
 * Emulation travels over the attachment too, and is applied on attach, on every
 * main-frame navigation, and when a pane's declared values change — never on a renderer
 * process swap, which overrides were measured surviving untouched ([ADR-0002]). Reapplying
 * on navigation is insurance, not a fix for an observed failure, and it is invisible: no
 * reload, no entry unless something it applies stops or starts working.
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

interface GuestBinding extends PendingGuest {
  guest: WebContents
}

interface GuestAttachment {
  pane: string
  guest: WebContents
  attempt: 1 | 2
}

interface WebviewAttachment {
  event: Electron.Event
  preferences: WebPreferences
  params: Record<string, string>
}

export class PaneHost {
  private readonly hosts = new WeakSet<WebContents>()
  private readonly sessions = new WeakSet<Session>()
  private readonly guests = new Map<string, WebContents>()
  /**
   * Guests whose attachment is ours. `isAttached` cannot say: it is true of a guest some
   * other client attached to, and that attachment is not ours to emulate over.
   */
  private readonly attachments = new WeakSet<WebContents>()
  /** The latest emulation pass per guest, so a slow answer cannot report over a newer one. */
  private readonly passes = new WeakMap<WebContents, number>()
  private pending: PendingGuest | null = null

  constructor(
    private readonly panes: PaneService,
    feed: StateFeed
  ) {
    feed.subscribe(({ patch }) => {
      if (patch.type !== 'pane.changed') return
      const guest = this.guests.get(patch.pane.id)
      if (guest) this.emulate(patch.pane.id, guest)
    })
  }

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
        this.secureSession(contents.session)
        contents.on('will-navigate', (event) => {
          if (!isWebUrl(event.url)) event.preventDefault()
        })
        contents.on('will-redirect', (event) => {
          if (event.isMainFrame && !isWebUrl(event.url)) event.preventDefault()
        })
        // Electron dispatches webview.src/loadURL through this method, bypassing
        // will-navigate. Reject before navigation starts: stop() inside
        // did-start-navigation crashes Electron 44; deferring it risks a commit.
        const loadURL = contents.loadURL.bind(contents)
        contents.loadURL = (url: string, options?: LoadURLOptions): Promise<void> => {
          if (!isWebUrl(url)) {
            return Promise.reject(new Error('Pane navigation requires an http: or https: URL'))
          }
          return loadURL(url, options)
        }
      }
      contents.on('will-attach-webview', (event, preferences, params) => {
        if (!this.hosts.has(contents)) {
          event.preventDefault()
          return
        }
        this.willAttach({ event, preferences, params })
      })
      contents.on('did-attach-webview', (_attached, guest) => {
        if (this.hosts.has(contents)) this.didAttach(guest)
      })
    })
  }

  private secureSession(session: Session): void {
    if (this.sessions.has(session)) return
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
    this.sessions.add(session)
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
  private willAttach({ event, preferences, params }: WebviewAttachment): void {
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
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false

    if (pane === null || !this.panes.has(pane) || !isWebUrl(params.src)) {
      event.preventDefault()
      return
    }
    // `did-attach-webview` for this guest fires in this same task, before any other
    // guest's `will-attach-webview` can, so one slot is enough to carry the pane across.
    this.pending = { pane, src: params.src }
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
    this.bind({ ...pending, guest })
  }

  private bind({ pane, guest, src }: GuestBinding): void {
    this.guests.set(pane, guest)
    const current = (): boolean => this.isCurrent(pane, guest)

    // Listeners before the attachment, so a refused attachment cannot cost the pane
    // its lifecycle (#4).
    // A failed load is followed by `did-finish-load` for Chromium's own error page, which
    // is not the pane's page loading. Each load starts clean.
    let failed = false
    guest.on('did-start-loading', () => {
      failed = false
    })
    guest.on('did-finish-load', () => {
      if (!failed && current()) this.panes.loaded(pane, guest.getURL())
    })
    guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      failed = true
      if (current()) this.panes.loadFailed({ pane, url, code, message: description })
    })
    guest.on('did-navigate', () => {
      if (current()) this.emulate(pane, guest)
    })
    guest.once('destroyed', () => {
      const wasCurrent = current()
      if (wasCurrent) this.guests.delete(pane)
      this.panes.guestDestroyed({ pane, current: wasCurrent })
    })

    this.panes.guestCreated(pane, src)
    this.attach({ pane, guest, attempt: 1 })
  }

  /** Whether `guest` is still the pane's, rather than one it has since replaced. */
  private isCurrent(pane: string, guest: WebContents): boolean {
    return this.guests.get(pane) === guest
  }

  /**
   * Attachment failure never fails the pane: it renders, degraded, with the reason
   * recorded. One retry once the page has loaded, then stop — no backoff loop.
   */
  private attach({ pane, guest, attempt }: GuestAttachment): void {
    try {
      guest.debugger.attach(CDP_VERSION)
    } catch (error) {
      const retrying = attempt === 1
      const message = error instanceof Error ? error.message : String(error)
      this.panes.attachFailed({ pane, attempt, retrying, message })
      if (retrying) {
        guest.once('did-stop-loading', () => {
          if (!guest.isDestroyed() && this.isCurrent(pane, guest)) {
            this.attach({ pane, guest, attempt: 2 })
          }
        })
      }
      return
    }
    this.attachments.add(guest)
    guest.debugger.once('detach', () => this.attachments.delete(guest))
    this.panes.attached(pane, attempt)
    this.emulate(pane, guest)
  }

  /**
   * Sends every override for what the pane declares now, each on its own, and reports what
   * took. A pane with no attachment is left alone: its status already says why.
   */
  private emulate(pane: string, guest: WebContents): void {
    const declared = this.panes.paneFor(pane)
    if (!declared || guest.isDestroyed() || !this.attachments.has(guest)) return
    const pass = (this.passes.get(guest) ?? 0) + 1
    this.passes.set(guest, pass)

    void applyEmulation(emulationFor(declared, process.versions.chrome), ({ method, params }) =>
      guest.debugger.sendCommand(method, params)
    ).then((results) => {
      if (this.passes.get(guest) === pass && this.isCurrent(pane, guest)) {
        this.panes.emulated(pane, results)
      }
    })
  }
}
