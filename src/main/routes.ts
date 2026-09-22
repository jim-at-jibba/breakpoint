import { isCursorPosition, type EventLog } from '../shared/event-log'
import { isColorScheme, isLayout } from '../shared/project'
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

/**
 * The params object, or nothing if what arrived was not one. Every route taking params
 * starts here, so "this is not even an object" is one answer rather than four.
 */
function asParams(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

/** Names not in `allowed`: a misspelt field is a change that silently changes nothing. */
function unknownFields(params: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(params).filter((key) => !allowed.includes(key))
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
  const report = asParams(raw)
  if (!report) return { ok: false, message: shape }
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

const EMULATION_FIELDS = ['colorScheme', 'dpr', 'mobile']

function expectEmulationSetting(raw: unknown): ParamsOk<'panes.setEmulation'> | ParamsBad {
  const shape = 'this route takes { pane } and at least one of colorScheme, dpr, mobile'
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: shape }
  if (typeof setting.pane !== 'string' || setting.pane.length === 0) {
    return { ok: false, message: 'pane must be a non-empty string' }
  }
  const unknown = unknownFields(setting, ['pane', ...EMULATION_FIELDS])
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { colorScheme, dpr, mobile } = setting
  if (colorScheme === undefined && dpr === undefined && mobile === undefined) {
    return { ok: false, message: shape }
  }
  if (colorScheme !== undefined && !isColorScheme(colorScheme)) {
    return { ok: false, message: 'colorScheme must be light, dark or system' }
  }
  if (dpr !== undefined && !(typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0)) {
    return { ok: false, message: 'dpr must be a finite number above 0' }
  }
  if (mobile !== undefined && typeof mobile !== 'boolean') {
    return { ok: false, message: 'mobile must be true or false' }
  }
  return {
    ok: true,
    params: {
      pane: setting.pane,
      ...(colorScheme !== undefined && { colorScheme }),
      ...(dpr !== undefined && { dpr }),
      ...(mobile !== undefined && { mobile })
    }
  }
}

const LAYOUT_FIELDS = ['layout', 'focusedPane']

function expectLayoutSetting(raw: unknown): ParamsOk<'project.setLayout'> | ParamsBad {
  const shape = 'this route takes { layout } and optionally { focusedPane }'
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: shape }
  const unknown = unknownFields(setting, LAYOUT_FIELDS)
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { layout, focusedPane } = setting
  if (!isLayout(layout)) return { ok: false, message: 'layout must be horizontal or focus' }
  if (focusedPane !== undefined && (typeof focusedPane !== 'string' || focusedPane.length === 0)) {
    return { ok: false, message: 'focusedPane must be a non-empty string' }
  }
  return { ok: true, params: { layout, ...(focusedPane !== undefined && { focusedPane }) } }
}

function expectZoomSetting(raw: unknown): ParamsOk<'project.setZoom'> | ParamsBad {
  const shape = 'this route takes { zoom }: a number of percent, or "fit"'
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: shape }
  const unknown = unknownFields(setting, ['zoom'])
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { zoom } = setting
  if (zoom === 'fit') return { ok: true, params: { zoom } }
  // A zoom past the ends of the control is clamped by the service, not refused here.
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return { ok: false, message: shape }
  }
  return { ok: true, params: { zoom } }
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
    'panes.setEmulation': {
      parseParams: expectEmulationSetting,
      handle: async (setting) => ({ payload: await services.panes.setEmulation(setting) })
    },
    'project.open': {
      parseParams: expectPath,
      handle: async ({ path }) => ({ payload: await services.project.open(path) })
    },
    'project.setLayout': {
      parseParams: expectLayoutSetting,
      handle: async (setting) => ({ payload: await services.project.setLayout(setting) })
    },
    'project.setZoom': {
      parseParams: expectZoomSetting,
      handle: async ({ zoom }) => ({ payload: await services.project.setZoom(zoom) })
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
