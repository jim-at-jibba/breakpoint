import { isCursorPosition, type EventLog } from '../shared/event-log'
import { failure, success, type RouteRequest, type RouteResponse } from '../shared/protocol'
import { isRouteName, type RouteName, type RouteParams, type RoutePayload } from '../shared/routes'
import { RouteError } from './route-error'
import { AppService } from './services/app-service'
import { PaneService } from './services/pane-service'
import { ProjectService } from './services/project-service'

/**
 * The route table. One name, one service method, JSON in and JSON out.
 *
 * Both adapters — typed IPC for the renderer, the local socket for the CLI — call
 * `dispatch` and nothing else, so a route reached from a terminal and the same route
 * reached from a button are the same code path ([ADR-0005]).
 */

export interface ParamsOk<N extends RouteName> {
  ok: true
  params: RouteParams<N>
}

export interface ParamsBad {
  ok: false
  message: string
}

export interface RouteResult<N extends RouteName> {
  payload: RoutePayload<N>
  /**
   * Run once the response is on its way to the caller. `app.quit` needs it: the reply
   * has to leave before the process does.
   */
  afterRespond?: () => void
}

interface RouteEntry<N extends RouteName> {
  parseParams(raw: unknown): ParamsOk<N> | ParamsBad
  handle(params: RouteParams<N>): RouteResult<N> | Promise<RouteResult<N>>
}

type RouteTable = { [N in RouteName]: RouteEntry<N> }

/** The routes whose params are `undefined`, read off the signatures rather than listed. */
type NoParamsRoute = { [N in RouteName]: RouteParams<N> extends undefined ? N : never }[RouteName]

function expectNoParams<N extends NoParamsRoute>(raw: unknown): ParamsOk<N> | ParamsBad {
  if (raw !== undefined && raw !== null) {
    return { ok: false, message: 'this route takes no params' }
  }
  return { ok: true, params: undefined as RouteParams<N> }
}

function expectPath(raw: unknown): ParamsOk<'project.open'> | ParamsBad {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'this route takes { path }' }
  }
  const { path } = raw as { path?: unknown }
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, message: 'path must be a non-empty string' }
  }
  return { ok: true, params: { path } }
}

function expectSince(raw: unknown): ParamsOk<'log.read'> | ParamsBad {
  if (raw === undefined || raw === null) return { ok: true, params: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'this route takes { since }' }
  }
  const { since } = raw as { since?: unknown }
  if (since === undefined) return { ok: true, params: {} }
  if (!isCursorPosition(since)) {
    return { ok: false, message: 'since must be a cursor position: an integer of 0 or more' }
  }
  return { ok: true, params: { since } }
}

function expectSize(raw: unknown): { width: number; height: number } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { width, height } = raw as { width?: unknown; height?: unknown }
  const measure = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  return measure(width) && measure(height) ? { width, height } : undefined
}

function expectGeometryReport(raw: unknown): ParamsOk<'panes.reportGeometry'> | ParamsBad {
  const shape =
    'this route takes { pane, expected: { width, height }, measured: { width, height } }'
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: shape }
  }
  const report = raw as { pane?: unknown; expected?: unknown; measured?: unknown }
  if (typeof report.pane !== 'string' || report.pane.length === 0) {
    return { ok: false, message: 'pane must be a non-empty string' }
  }
  const expected = expectSize(report.expected)
  const measured = expectSize(report.measured)
  if (!expected || !measured) {
    return { ok: false, message: `${shape}, in finite pixels of 0 or more` }
  }
  return { ok: true, params: { pane: report.pane, expected, measured } }
}

export interface DispatchResult {
  response: RouteResponse
  afterRespond?: () => void
}

export type Dispatch = (request: RouteRequest) => Promise<DispatchResult>

/**
 * Keyed by the route noun. The log is a store rather than one of PRD 8.1's services and
 * reaches the table as it is: a service over it would hold no behaviour of its own,
 * which is the thing the boundary exists to prevent ([ADR-0005]).
 */
export interface Services {
  app: AppService
  log: EventLog
  panes: PaneService
  project: ProjectService
}

export function createRouteTable(services: Services): RouteTable {
  return {
    'app.quit': {
      parseParams: expectNoParams,
      handle: () => ({ payload: { quitting: true }, afterRespond: () => services.app.quit() })
    },
    'log.read': {
      parseParams: expectSince,
      handle: (params) => ({ payload: services.log.read(params) })
    },
    'panes.list': {
      parseParams: expectNoParams,
      handle: () => ({ payload: services.panes.list() })
    },
    'panes.reportGeometry': {
      parseParams: expectGeometryReport,
      handle: (report) => ({ payload: services.panes.reportGeometry(report) })
    },
    'project.open': {
      parseParams: expectPath,
      handle: async ({ path }) => ({ payload: await services.project.open(path) })
    },
    'project.state': {
      parseParams: expectNoParams,
      handle: () => ({ payload: services.project.snapshot() })
    }
  }
}

export function createDispatch(table: RouteTable): Dispatch {
  return async function dispatch(request: RouteRequest): Promise<DispatchResult> {
    const { id, route } = request

    if (!isRouteName(route)) {
      return { response: failure(id, 'UNKNOWN_ROUTE', `no route named ${route}`) }
    }

    // Method parameters are bivariant, so the union of entries reads as one entry taking
    // the union of params; the table itself is still checked per route above.
    const entry = table[route] as RouteEntry<RouteName>

    const params = entry.parseParams(request.params)
    if (!params.ok) {
      return { response: failure(id, 'INVALID_PARAMS', params.message) }
    }

    try {
      const result = await entry.handle(params.params)
      return { response: success(id, result.payload), afterRespond: result.afterRespond }
    } catch (error) {
      if (error instanceof RouteError) {
        return { response: failure(id, error.code, error.message, error.details) }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { response: failure(id, 'INTERNAL_ERROR', message) }
    }
  }
}
