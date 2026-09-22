/**
 * The route table's names and their shapes.
 *
 * Every surface — the UI over typed IPC, the CLI over the local socket, MCP later —
 * reaches a main-process service through one of these names ([ADR-0005]). If a surface
 * can cause a service call, that call is a route; there is no UI-only route.
 *
 * Both TypeScript projects include this file, so a name added here is a name the
 * renderer, the main process and the CLI all see at once.
 */

import type { CertificateKey, CertificateState } from './certificates'
import type { EmulationChanges } from './emulation'
import type { LogRead, ReadParams } from './event-log'
import type { PaneStatus, Size } from './panes'
import type { Preset } from './presets'
import type { Layout, Pane, Zoom } from './project'
import type { StateSnapshot } from './state'
import type { ThemePreference, ThemeState } from './theme'

/** A route is a dotted `noun.verb`. The noun is the service, the verb is the method. */
export const ROUTE_NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/

export const ROUTE_NAMES = [
  'app.focus',
  'app.quit',
  'app.setTheme',
  'certificates.decide',
  'certificates.forget',
  'certificates.list',
  'log.read',
  'panes.add',
  'panes.list',
  'panes.remove',
  'panes.reportGeometry',
  'panes.resize',
  'panes.rotate',
  'panes.setEmulation',
  'presets.list',
  'project.navigate',
  'project.open',
  'project.setAllowedOrigins',
  'project.setLayout',
  'project.setZoom',
  'project.state'
] as const

export type RouteName = (typeof ROUTE_NAMES)[number]

/**
 * Which surface a call arrived from ([CONTEXT.md]). Every route is reachable from every
 * one of them; the only thing this decides is whether a call is the developer acting or
 * automation acting on their behalf, which is what the origin allow-list binds
 * ([ADR-0013]).
 */
export type Surface = 'window' | 'cli'

/**
 * Params and payload per route. Both must be JSON-serialisable: no Electron object
 * crosses this boundary, because the socket could not carry one.
 */
export interface RouteSignatures {
  /**
   * Brings the app's window forward and gives it focus. What `breakpoint .` does after
   * handing a repo to a running app, and what `--background` is the way to skip. Creates
   * a window first when the app is alive without one on macOS.
   */
  'app.focus': { params: undefined; payload: { focused: true } }
  'app.quit': { params: undefined; payload: { quitting: true } }
  /**
   * Sets the app theme: `system` follows the OS, `light` and `dark` override it. An
   * app-level setting rather than a project's, kept on this machine, so it survives a
   * restart and does not change when a different project is opened.
   *
   * Never touches a pane's colour scheme, which is emulation applied to a page we do not
   * own ([CONTEXT.md]). The payload is the preference and what it resolves to now.
   */
  'app.setTheme': { params: { preference: ThemePreference }; payload: ThemeState }
  /**
   * Answers one certificate that is waiting on the developer, naming it by the host and
   * fingerprint it is keyed on ([ADR-0012]). Trusting it releases every pane held by it
   * and keeps the decision; refusing it releases them with the load failed and keeps
   * nothing, so the next attempt asks again. Either way the request is gone, and a host
   * and fingerprint nothing is waiting on is `CERTIFICATE_NOT_FOUND`.
   */
  'certificates.decide': { params: CertificateDecision; payload: CertificateState }
  /**
   * Drops a stored decision, so that certificate on that host prompts the next time it
   * is served. A host and fingerprint nothing is stored for is `CERTIFICATE_NOT_FOUND`.
   */
  'certificates.forget': { params: CertificateKey; payload: CertificateState }
  /**
   * Every certificate decision stored on this machine, and every certificate waiting on
   * the developer right now. Global rather than a project's: a certificate belongs to a
   * host, and two projects on one staging server are one decision.
   */
  'certificates.list': { params: undefined; payload: CertificateState }
  /**
   * Everything the event log holds after a cursor position. Omitting `since` reads from
   * the beginning, which is everything the ring buffers still hold rather than
   * everything that ever happened.
   */
  'log.read': { params: ReadParams; payload: LogRead }
  /**
   * Adds a pane to the open project, from a preset or at a size the caller gives, and
   * appends it to the set. A preset is resolved once into the pane's own values here and
   * never consulted again ([ADR-0011]), so editing it afterwards leaves this pane alone.
   */
  'panes.add': { params: PaneCreation; payload: { pane: PaneListing; index: number } }
  /** The open project's panes, each with what is observed of it. Empty with nothing open. */
  'panes.list': { params: undefined; payload: { panes: PaneListing[] } }
  /** Takes a pane out of the open project, leaving every other pane as it was. */
  'panes.remove': { params: { pane: string }; payload: { pane: Pane } }
  /**
   * The host-side geometry check's measurement of one pane ([ADR-0004]), in screen
   * pixels: its declared size times the canvas zoom, and its element's own rendered box.
   * The window is the surface that can measure, but the route is anyone's. A mismatch
   * degrades the pane and writes an entry; nothing resizes the pane to match.
   */
  'panes.reportGeometry': { params: GeometryReport; payload: { status: PaneStatus } }
  /**
   * Declares a pane's exact size in CSS pixels, one dimension or both. Resizing is a
   * change to the canvas as well as to emulation, which is why it is here and not in
   * `panes.setEmulation`. One dimension at a time because that is how a developer types
   * it: a width committed on its own must not carry a height the pane no longer has.
   */
  'panes.resize': { params: PaneResize; payload: { pane: PaneListing } }
  /** Swaps a pane's width and height, so landscape needs no arithmetic. */
  'panes.rotate': { params: { pane: string }; payload: { pane: PaneListing } }
  /**
   * Changes what one pane emulates — DPR, the mobile flag, colour scheme — and keeps it
   * with the project. The payload is the pane as now declared; whether each override took
   * is its status, which follows once the pane's guest has been told.
   */
  'panes.setEmulation': { params: EmulationSetting; payload: { pane: PaneListing } }
  /**
   * Every preset, as the global file declares them. Read from disk per call, so a file
   * the developer edited in another window is the one the next pane is created from.
   */
  'presets.list': { params: undefined; payload: { presets: Preset[] } }
  /**
   * Points every pane of the open project at one URL. `url` is what was typed: a bare
   * port expands to this machine's dev server, so `3000` is a navigation. Navigating to
   * the URL the project already holds still moves the panes, because a pane may have
   * been clicked somewhere else since.
   *
   * Refused with `ORIGIN_NOT_ALLOWED` when it arrives from the CLI for an origin the
   * project does not allow, and from nowhere else ([ADR-0013]).
   */
  'project.navigate': { params: { url: string }; payload: Navigation }
  /**
   * Opens the project for a repo, creating it the first time. `path` is absolute: the
   * caller resolves it against its own working directory, which the app cannot know.
   */
  'project.open': { params: { path: string }; payload: StateSnapshot }
  /**
   * Replaces the origins automation may navigate the project to. Each is stored as its
   * origin, so a value with a path on it is kept as the origin it names. Kept with the
   * project, so an edit survives a restart.
   */
  'project.setAllowedOrigins': {
    params: { origins: string[] }
    payload: { origins: string[] }
  }
  /**
   * Arranges the open project's panes, and names the pane Focus draws at 100%. Naming a
   * pane without changing the layout is how the focused pane is changed. Kept with the
   * project.
   */
  'project.setLayout': { params: LayoutSetting; payload: LayoutState }
  /**
   * Sets the open project's zoom, which may be `Fit` — a value of the control, not a
   * layout ([ADR-0009]). What Fit currently computes to is the renderer's, because only
   * the renderer knows how much room it has; the main process keeps the value only.
   */
  'project.setZoom': { params: { zoom: Zoom }; payload: { zoom: Zoom } }
  /** The snapshot every surface renders from. `project` is null until one is opened. */
  'project.state': { params: undefined; payload: StateSnapshot }
}

export type PaneListing = Pane & { status: PaneStatus }

/** Answering one waiting certificate: which, and whether it is trusted. */
export type CertificateDecision = CertificateKey & { trusted: boolean }

/** Where the project now points, and the panes that were sent there. */
export interface Navigation {
  /** The URL as expanded, which is what the panes were given and what is stored. */
  url: string
  /** The ids of the panes pointed at it, in the order the project holds them. */
  panes: string[]
}

export interface LayoutSetting {
  layout: Layout
  /** Omitted leaves the focused pane as it was. */
  focusedPane?: string
}

/** How the panes are arranged now. `focusedPane` is null for whichever pane is first. */
export interface LayoutState {
  layout: Layout
  focusedPane: string | null
}

export interface GeometryReport {
  pane: string
  expected: Size
  measured: Size
}

export type EmulationSetting = EmulationChanges & { pane: string }

/** A pane from a preset, or one at a size the developer typed. Never both. */
export type PaneCreation =
  | { preset: string; width?: never; height?: never }
  | { preset?: never; width: number; height: number }

/** At least one dimension is required; each may be committed independently. */
export type PaneResize = { pane: string } & (
  { width: number; height?: number } | { width?: number; height: number }
)

export type RouteParams<N extends RouteName> = RouteSignatures[N]['params']
export type RoutePayload<N extends RouteName> = RouteSignatures[N]['payload']

const ROUTE_NAME_SET: ReadonlySet<string> = new Set(ROUTE_NAMES)

export function isRouteName(value: unknown): value is RouteName {
  return typeof value === 'string' && ROUTE_NAME_SET.has(value)
}
