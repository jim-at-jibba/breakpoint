import { failure, success, type RouteRequest, type RouteResponse } from '../shared/protocol'
import { isRouteName, type RouteName, type RouteParams, type RoutePayload } from '../shared/routes'
import { RouteError } from './route-error'
import { AppService } from './services/app-service'
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

export interface DispatchResult {
  response: RouteResponse
  afterRespond?: () => void
}

export type Dispatch = (request: RouteRequest) => Promise<DispatchResult>

export interface Services {
  app: AppService
  project: ProjectService
}

export function createRouteTable(services: Services): RouteTable {
  return {
    'app.quit': {
      parseParams: expectNoParams,
      handle: () => ({ payload: { quitting: true }, afterRespond: () => services.app.quit() })
    },
    'project.open': {
      parseParams: expectPath,
      handle: ({ path }) => ({ payload: services.project.open(path) })
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
