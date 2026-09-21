import { isCursorPosition, type EventLog } from '../shared/event-log'
import { isPaneDimension, PANE_DIMENSION_RANGE } from '../shared/panes'
import { isColorScheme } from '../shared/project'
import { failure, success, type RouteRequest, type RouteResponse } from '../shared/protocol'
import { isRouteName, type RouteName, type RouteParams, type RoutePayload } from '../shared/routes'
import { RouteError } from './route-error'
import { AppService } from './services/app-service'
import { PaneService } from './services/pane-service'
import { PresetService } from './services/preset-service'
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

/** The one shape every route naming a pane takes, so `pane` is refused the same way. */
function expectPane(raw: unknown, shape: string): { pane: string } | ParamsBad {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: shape }
  }
  const { pane } = raw as { pane?: unknown }
  if (typeof pane !== 'string' || pane.length === 0) {
    return { ok: false, message: 'pane must be a non-empty string' }
  }
  return { pane }
}

function isBad(value: { pane: string } | ParamsBad): value is ParamsBad {
  return 'ok' in value
}

const PANE_SHAPE = 'this route takes { pane }'

function expectPaneOnly<N extends 'panes.remove' | 'panes.rotate'>(
  raw: unknown
): ParamsOk<N> | ParamsBad {
  const named = expectPane(raw, PANE_SHAPE)
  if (isBad(named)) return named
  const unknown = Object.keys(raw as object).filter((key) => key !== 'pane')
  if (unknown.length > 0) return { ok: false, message: `${PANE_SHAPE}, not ${unknown.join(', ')}` }
  return { ok: true, params: named as RouteParams<N> }
}

const DIMENSIONS = `whole numbers of CSS pixels from ${PANE_DIMENSION_RANGE.min} to ${PANE_DIMENSION_RANGE.max}`

function expectPaneResize(raw: unknown): ParamsOk<'panes.resize'> | ParamsBad {
  const shape = 'this route takes { pane } and at least one of width, height'
  const named = expectPane(raw, shape)
  if (isBad(named)) return named
  const unknown = Object.keys(raw as object).filter(
    (key) => !['pane', 'width', 'height'].includes(key)
  )
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { width, height } = raw as { width?: unknown; height?: unknown }
  if (width === undefined && height === undefined) return { ok: false, message: shape }
  for (const value of [width, height]) {
    if (value !== undefined && !isPaneDimension(value)) {
      return { ok: false, message: `${shape}, in ${DIMENSIONS}` }
    }
  }
  return {
    ok: true,
    params: {
      pane: named.pane,
      ...(width !== undefined && { width: width as number }),
      ...(height !== undefined && { height: height as number })
    }
  }
}

const CREATION_FIELDS = ['preset', 'name', 'width', 'height'] as const

function expectPaneCreation(raw: unknown): ParamsOk<'panes.add'> | ParamsBad {
  const shape = 'this route takes { preset } or { width, height }, with an optional name'
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: shape }
  }
  const creation = raw as Record<string, unknown>
  const unknown = Object.keys(creation).filter(
    (key) => !(CREATION_FIELDS as readonly string[]).includes(key)
  )
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { preset, name, width, height } = creation
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
    return { ok: false, message: 'name must be a non-empty string' }
  }
  const named = name === undefined ? {} : { name }

  if (preset !== undefined) {
    // A preset and a size together would leave it unsaid which one the pane came from.
    if (width !== undefined || height !== undefined) {
      return { ok: false, message: `${shape}, not both` }
    }
    if (typeof preset !== 'string' || preset.length === 0) {
      return { ok: false, message: 'preset must be a non-empty string' }
    }
    return { ok: true, params: { preset, ...named } }
  }
  if (!isPaneDimension(width) || !isPaneDimension(height)) {
    return { ok: false, message: `${shape}, in ${DIMENSIONS}` }
  }
  return { ok: true, params: { width, height, ...named } }
}

const EMULATION_FIELDS = ['colorScheme', 'dpr', 'mobile', 'touch'] as const

function expectEmulationSetting(raw: unknown): ParamsOk<'panes.setEmulation'> | ParamsBad {
  const shape = `this route takes { pane } and at least one of ${EMULATION_FIELDS.join(', ')}`
  const named = expectPane(raw, shape)
  if (isBad(named)) return named
  const setting = raw as Record<string, unknown>
  // A misspelt field would otherwise be a change that silently changes nothing.
  const unknown = Object.keys(setting).filter(
    (key) => key !== 'pane' && !(EMULATION_FIELDS as readonly string[]).includes(key)
  )
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { colorScheme, dpr, mobile, touch } = setting
  if (
    colorScheme === undefined &&
    dpr === undefined &&
    mobile === undefined &&
    touch === undefined
  ) {
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
  if (touch !== undefined && typeof touch !== 'boolean') {
    return { ok: false, message: 'touch must be true or false' }
  }
  return {
    ok: true,
    params: {
      pane: named.pane,
      ...(colorScheme !== undefined && { colorScheme }),
      ...(dpr !== undefined && { dpr }),
      ...(mobile !== undefined && { mobile }),
      ...(touch !== undefined && { touch })
    }
  }
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
  presets: PresetService
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
    'panes.add': {
      parseParams: expectPaneCreation,
      handle: async (creation) => ({ payload: await services.panes.add(creation) })
    },
    'panes.list': {
      parseParams: expectNoParams,
      handle: () => ({ payload: services.panes.list() })
    },
    'panes.remove': {
      parseParams: expectPaneOnly,
      handle: async ({ pane }) => ({ payload: await services.panes.remove(pane) })
    },
    'panes.reportGeometry': {
      parseParams: expectGeometryReport,
      handle: (report) => ({ payload: services.panes.reportGeometry(report) })
    },
    'panes.resize': {
      parseParams: expectPaneResize,
      handle: async (resize) => ({ payload: await services.panes.resize(resize) })
    },
    'panes.rotate': {
      parseParams: expectPaneOnly,
      handle: async ({ pane }) => ({ payload: await services.panes.rotate(pane) })
    },
    'panes.setEmulation': {
      parseParams: expectEmulationSetting,
      handle: async (setting) => ({ payload: await services.panes.setEmulation(setting) })
    },
    'presets.list': {
      parseParams: expectNoParams,
      handle: async () => ({ payload: await services.presets.list() })
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
