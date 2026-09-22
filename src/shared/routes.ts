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
import type { Preset } from './presets'
import type { Pane } from './project'
import type { StateSnapshot } from './state'

/** A route is a dotted `noun.verb`. The noun is the service, the verb is the method. */
export const ROUTE_NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/

export const ROUTE_NAMES = [
  'app.quit',
  'log.read',
  'panes.add',
  'panes.list',
  'panes.remove',
  'panes.reportGeometry',
  'panes.resize',
  'panes.rotate',
  'panes.setEmulation',
  'presets.list',
  'project.open',
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
   * Opens the project for a repo, creating it the first time. `path` is absolute: the
   * caller resolves it against its own working directory, which the app cannot know.
   */
  'project.open': { params: { path: string }; payload: StateSnapshot }
  /** The snapshot every surface renders from. `project` is null until one is opened. */
  'project.state': { params: undefined; payload: StateSnapshot }
}

export type PaneListing = Pane & { status: PaneStatus }

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
