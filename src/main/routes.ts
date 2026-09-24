import { isCursorPosition, type EventLog } from '../shared/event-log'
import { isPaneDimension, PANE_DIMENSION_RANGE } from '../shared/panes'
import type { CertificateKey } from '../shared/certificates'
import { isColorScheme, isLayout } from '../shared/project'
import { failure, success, type RouteRequest, type RouteResponse } from '../shared/protocol'
import {
  isRouteName,
  type RouteName,
  type RouteParams,
  type RoutePayload,
  type Surface
} from '../shared/routes'
import { isThemePreference } from '../shared/theme'
import { expandUrl } from '../shared/urls'
import { RouteError } from './route-error'
import { AppService } from './services/app-service'
import { CertificateService } from './services/certificate-service'
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

/**
 * What the table knows about the call beyond its params: which surface made it. Every
 * route is reachable from every surface ([ADR-0005]); this is how the one route that
 * treats automation differently from the developer can tell them apart ([ADR-0013]).
 */
export interface RouteContext {
  surface: Surface
}

interface RouteEntry<N extends RouteName> {
  parseParams(raw: unknown): ParamsOk<N> | ParamsBad
  handle(params: RouteParams<N>, context: RouteContext): RouteResult<N> | Promise<RouteResult<N>>
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

/** A parser helper returned the refusal rather than the value it was asked for. */
function isRefusal<T extends object>(value: T | ParamsBad): value is ParamsBad {
  return 'ok' in value
}

/**
 * A field the route does not take is a refusal, not a field to ignore: a misspelt one
 * would otherwise be a change that silently changes nothing.
 */
function rejectUnknown(
  raw: unknown,
  fields: readonly string[],
  shape: string
): ParamsBad | undefined {
  const unknown = Object.keys(raw as object).filter((key) => !fields.includes(key))
  if (unknown.length === 0) return undefined
  return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }
}

const PANE_SHAPE = 'this route takes { pane }'

function expectPaneOnly<N extends 'panes.remove' | 'panes.rotate'>(
  raw: unknown
): ParamsOk<N> | ParamsBad {
  const named = expectPane(raw, PANE_SHAPE)
  if (isRefusal(named)) return named
  const refused = rejectUnknown(raw, ['pane'], PANE_SHAPE)
  if (refused) return refused
  return { ok: true, params: named as RouteParams<N> }
}

const DIMENSIONS = `whole numbers of CSS pixels from ${PANE_DIMENSION_RANGE.min} to ${PANE_DIMENSION_RANGE.max}`

function expectPaneResize(raw: unknown): ParamsOk<'panes.resize'> | ParamsBad {
  const shape = 'this route takes { pane } and at least one of width, height'
  const named = expectPane(raw, shape)
  if (isRefusal(named)) return named
  const refused = rejectUnknown(raw, ['pane', 'width', 'height'], shape)
  if (refused) return refused

  const { width, height } = raw as { width?: unknown; height?: unknown }
  if (width === undefined && height === undefined) return { ok: false, message: shape }
  for (const value of [width, height]) {
    if (value !== undefined && !isPaneDimension(value)) {
      return { ok: false, message: `${shape}, in ${DIMENSIONS}` }
    }
  }
  if (width !== undefined) {
    return {
      ok: true,
      params: {
        pane: named.pane,
        width: width as number,
        ...(height !== undefined && { height: height as number })
      }
    }
  }
  return { ok: true, params: { pane: named.pane, height: height as number } }
}

const CREATION_FIELDS = ['preset', 'width', 'height'] as const

function expectPaneCreation(raw: unknown): ParamsOk<'panes.add'> | ParamsBad {
  const shape = 'this route takes { preset } or { width, height }'
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: shape }
  }
  const refused = rejectUnknown(raw, CREATION_FIELDS, shape)
  if (refused) return refused

  const { preset, width, height } = raw as Record<string, unknown>
  if (preset !== undefined) {
    // A preset and a size together would leave it unsaid which one the pane came from.
    if (width !== undefined || height !== undefined) {
      return { ok: false, message: `${shape}, not both` }
    }
    if (typeof preset !== 'string' || preset.length === 0) {
      return { ok: false, message: 'preset must be a non-empty string' }
    }
    return { ok: true, params: { preset } }
  }
  if (!isPaneDimension(width) || !isPaneDimension(height)) {
    return { ok: false, message: `${shape}, in ${DIMENSIONS}` }
  }
  return { ok: true, params: { width, height } }
}

const EMULATION_FIELDS = ['colorScheme', 'dpr', 'mobile', 'touch'] as const

function expectEmulationSetting(raw: unknown): ParamsOk<'panes.setEmulation'> | ParamsBad {
  const shape = `this route takes { pane } and at least one of ${EMULATION_FIELDS.join(', ')}`
  const named = expectPane(raw, shape)
  if (isRefusal(named)) return named
  const setting = raw as Record<string, unknown>
  const refused = rejectUnknown(raw, ['pane', ...EMULATION_FIELDS], shape)
  if (refused) return refused

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

/**
 * What was typed, expanded here rather than in each surface, so `3000` reaches every
 * caller as the same URL — the address bar, `breakpoint open` and a socket call all get
 * the one rule.
 */
function expectNavigation(raw: unknown): ParamsOk<'project.navigate'> | ParamsBad {
  const shape = 'this route takes { url }'
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: shape }
  const unknown = unknownFields(setting, ['url'])
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { url } = setting
  if (typeof url !== 'string') return { ok: false, message: 'url must be a string' }
  const expanded = expandUrl(url)
  if (expanded === undefined) {
    return { ok: false, message: `${url} is not an http or https URL, or a port on this machine` }
  }
  return { ok: true, params: { url: expanded } }
}

function expectAllowedOrigins(raw: unknown): ParamsOk<'project.setAllowedOrigins'> | ParamsBad {
  const shape = 'this route takes { origins }: an array of http or https origins'
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: shape }
  const unknown = unknownFields(setting, ['origins'])
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { origins } = setting
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) {
    return { ok: false, message: shape }
  }
  return { ok: true, params: { origins: origins as string[] } }
}

const CERTIFICATE_KEY_FIELDS = ['host', 'fingerprint'] as const

/** The host and fingerprint both certificate routes name one decision by ([ADR-0012]). */
function expectCertificateKey(raw: unknown, shape: string): CertificateKey | ParamsBad {
  const params = asParams(raw)
  if (!params) return { ok: false, message: shape }
  const { host, fingerprint } = params
  if (typeof host !== 'string' || host.length === 0) {
    return { ok: false, message: 'host must be a non-empty string' }
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return { ok: false, message: 'fingerprint must be a non-empty string' }
  }
  return { host, fingerprint }
}

const FORGET_SHAPE = 'this route takes { host, fingerprint }'

function expectCertificateKeyOnly(raw: unknown): ParamsOk<'certificates.forget'> | ParamsBad {
  const key = expectCertificateKey(raw, FORGET_SHAPE)
  if (isRefusal(key)) return key
  const refused = rejectUnknown(raw, CERTIFICATE_KEY_FIELDS, FORGET_SHAPE)
  if (refused) return refused
  return { ok: true, params: key }
}

const DECIDE_SHAPE = 'this route takes { host, fingerprint, trusted }'

function expectCertificateDecision(raw: unknown): ParamsOk<'certificates.decide'> | ParamsBad {
  const key = expectCertificateKey(raw, DECIDE_SHAPE)
  if (isRefusal(key)) return key
  const refused = rejectUnknown(raw, [...CERTIFICATE_KEY_FIELDS, 'trusted'], DECIDE_SHAPE)
  if (refused) return refused

  const { trusted } = raw as { trusted?: unknown }
  if (typeof trusted !== 'boolean') return { ok: false, message: 'trusted must be true or false' }
  return { ok: true, params: { ...key, trusted } }
}

const THEME_SHAPE = 'this route takes { preference }: system, light or dark'

function expectThemeSetting(raw: unknown): ParamsOk<'app.setTheme'> | ParamsBad {
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: THEME_SHAPE }
  const unknown = unknownFields(setting, ['preference'])
  if (unknown.length > 0) return { ok: false, message: `${THEME_SHAPE}, not ${unknown.join(', ')}` }

  const { preference } = setting
  if (!isThemePreference(preference)) return { ok: false, message: THEME_SHAPE }
  return { ok: true, params: { preference } }
}

function expectSwitcherSetting(raw: unknown): ParamsOk<'app.setSwitcher'> | ParamsBad {
  const shape = 'this route takes { open }: whether the project switcher is showing'
  const setting = asParams(raw)
  if (!setting) return { ok: false, message: shape }
  const unknown = unknownFields(setting, ['open'])
  if (unknown.length > 0) return { ok: false, message: `${shape}, not ${unknown.join(', ')}` }

  const { open } = setting
  if (typeof open !== 'boolean') return { ok: false, message: shape }
  return { ok: true, params: { open } }
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

export type Dispatch = (request: RouteRequest, context: RouteContext) => Promise<DispatchResult>

/**
 * Keyed by the route noun. The log is a store rather than one of PRD 8.1's services and
 * reaches the table as it is: a service over it would hold no behaviour of its own,
 * which is the thing the boundary exists to prevent ([ADR-0005]).
 */
export interface Services {
  app: AppService
  certificates: CertificateService
  log: EventLog
  panes: PaneService
  presets: PresetService
  project: ProjectService
}

export function createRouteTable(services: Services): RouteTable {
  return {
    'app.focus': {
      parseParams: expectNoParams,
      handle: () => ({ payload: services.app.focus() })
    },
    'app.quit': {
      parseParams: expectNoParams,
      handle: () => ({ payload: { quitting: true }, afterRespond: () => services.app.quit() })
    },
    'app.setSwitcher': {
      parseParams: expectSwitcherSetting,
      handle: ({ open }) => ({ payload: services.app.setSwitcher(open) })
    },
    'app.setTheme': {
      parseParams: expectThemeSetting,
      handle: async ({ preference }) => ({ payload: await services.app.setTheme(preference) })
    },
    'certificates.decide': {
      parseParams: expectCertificateDecision,
      handle: async (decision) => ({ payload: await services.certificates.decide(decision) })
    },
    'certificates.forget': {
      parseParams: expectCertificateKeyOnly,
      handle: async (key) => ({ payload: await services.certificates.forget(key) })
    },
    'certificates.list': {
      parseParams: expectNoParams,
      handle: () => ({ payload: services.certificates.list() })
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
    'project.list': {
      parseParams: expectNoParams,
      handle: async () => ({ payload: await services.project.list() })
    },
    'project.navigate': {
      parseParams: expectNavigation,
      handle: async ({ url }, { surface }) => ({
        payload: await services.project.navigate(url, surface)
      })
    },
    'project.open': {
      parseParams: expectPath,
      handle: async ({ path }) => ({ payload: await services.project.open(path) })
    },
    'project.setAllowedOrigins': {
      parseParams: expectAllowedOrigins,
      handle: async ({ origins }) => ({
        payload: await services.project.setAllowedOrigins(origins)
      })
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
  return async function dispatch(
    request: RouteRequest,
    context: RouteContext
  ): Promise<DispatchResult> {
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
      const result = await entry.handle(params.params, context)
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
