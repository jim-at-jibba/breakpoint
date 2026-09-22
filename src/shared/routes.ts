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

import type { EmulationChanges } from './emulation'
import type { LogRead, ReadParams } from './event-log'
import type { PaneStatus, Size } from './panes'
import type { Layout, Pane, Zoom } from './project'
import type { StateSnapshot } from './state'

/** A route is a dotted `noun.verb`. The noun is the service, the verb is the method. */
export const ROUTE_NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/

export const ROUTE_NAMES = [
  'app.quit',
  'log.read',
  'panes.list',
  'panes.reportGeometry',
  'panes.setEmulation',
  'project.open',
  'project.setLayout',
  'project.setZoom',
  'project.state'
] as const

export type RouteName = (typeof ROUTE_NAMES)[number]

/**
 * Params and payload per route. Both must be JSON-serialisable: no Electron object
 * crosses this boundary, because the socket could not carry one.
 */
export interface RouteSignatures {
  'app.quit': { params: undefined; payload: { quitting: true } }
  /**
   * Everything the event log holds after a cursor position. Omitting `since` reads from
   * the beginning, which is everything the ring buffers still hold rather than
   * everything that ever happened.
   */
  'log.read': { params: ReadParams; payload: LogRead }
  /** The open project's panes, each with what is observed of it. Empty with nothing open. */
  'panes.list': { params: undefined; payload: { panes: PaneListing[] } }
  /**
   * The host-side geometry check's measurement of one pane ([ADR-0004]), in screen
   * pixels: its declared size times the canvas zoom, and its element's own rendered box.
   * The window is the surface that can measure, but the route is anyone's. A mismatch
   * degrades the pane and writes an entry; nothing resizes the pane to match.
   */
  'panes.reportGeometry': { params: GeometryReport; payload: { status: PaneStatus } }
  /**
   * Changes what one pane emulates — DPR, the mobile flag, colour scheme — and keeps it
   * with the project. The payload is the pane as now declared; whether each override took
   * is its status, which follows once the pane's guest has been told.
   */
  'panes.setEmulation': { params: EmulationSetting; payload: { pane: PaneListing } }
  /**
   * Opens the project for a repo, creating it the first time. `path` is absolute: the
   * caller resolves it against its own working directory, which the app cannot know.
   */
  'project.open': { params: { path: string }; payload: StateSnapshot }
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

export type RouteParams<N extends RouteName> = RouteSignatures[N]['params']
export type RoutePayload<N extends RouteName> = RouteSignatures[N]['payload']

const ROUTE_NAME_SET: ReadonlySet<string> = new Set(ROUTE_NAMES)

export function isRouteName(value: unknown): value is RouteName {
  return typeof value === 'string' && ROUTE_NAME_SET.has(value)
}
