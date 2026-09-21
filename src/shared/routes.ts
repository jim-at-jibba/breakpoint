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

import type { LogRead, ReadParams } from './event-log'
import type { StateSnapshot } from './state'

/** A route is a dotted `noun.verb`. The noun is the service, the verb is the method. */
export const ROUTE_NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/

export const ROUTE_NAMES = ['app.quit', 'log.read', 'project.open', 'project.state'] as const

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
   * Opens the project for a repo, creating it the first time. `path` is absolute: the
   * caller resolves it against its own working directory, which the app cannot know.
   */
  'project.open': { params: { path: string }; payload: StateSnapshot }
  /** The snapshot every surface renders from. `project` is null until one is opened. */
  'project.state': { params: undefined; payload: StateSnapshot }
}

export type RouteParams<N extends RouteName> = RouteSignatures[N]['params']
export type RoutePayload<N extends RouteName> = RouteSignatures[N]['payload']

const ROUTE_NAME_SET: ReadonlySet<string> = new Set(ROUTE_NAMES)

export function isRouteName(value: unknown): value is RouteName {
  return typeof value === 'string' && ROUTE_NAME_SET.has(value)
}
