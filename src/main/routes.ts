import { failure, success, type RouteRequest, type RouteResponse } from '../shared/protocol'
import { isRouteName, type RouteName, type RouteParams, type RoutePayload } from '../shared/routes'
import { AppService } from './services/app-service'

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

function expectNoParams(raw: unknown): ParamsOk<'app.quit'> | ParamsBad {
  if (raw !== undefined && raw !== null) {
    return { ok: false, message: 'this route takes no params' }
  }
  return { ok: true, params: undefined }
}

export interface DispatchResult {
  response: RouteResponse
  afterRespond?: () => void
}

export function createRouteTable(services: { app: AppService }): RouteTable {
  return {
    'app.quit': {
      parseParams: expectNoParams,
      handle: () => ({ payload: { quitting: true }, afterRespond: () => services.app.quit() })
    }
  }
}

export function createDispatch(table: RouteTable) {
  return async function dispatch(request: RouteRequest): Promise<DispatchResult> {
    const { id, route } = request

    if (!isRouteName(route)) {
      return { response: failure(id, 'unknown_route', `no route named ${route}`) }
    }

    // The table is keyed by the whole union, so every entry's parse and handle agree on
    // one route's types. Narrowing that back per name costs more than it proves here.
    const entry = table[route] as RouteEntry<RouteName>

    const params = entry.parseParams(request.params)
    if (!params.ok) {
      return { response: failure(id, 'invalid_params', params.message) }
    }

    try {
      const result = await entry.handle(params.params)
      return { response: success(id, result.payload), afterRespond: result.afterRespond }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { response: failure(id, 'internal_error', message) }
    }
  }
}

export type Dispatch = ReturnType<typeof createDispatch>
