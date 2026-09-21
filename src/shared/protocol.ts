/**
 * The request and response envelope both adapters carry, and the stable error codes
 * they report. The socket writes these as newline-delimited JSON, one request to one
 * response; IPC passes the same objects structured-cloned.
 */

/** Codes a route call can come back with. These travel over the wire. */
export const WIRE_ERROR_CODES = [
  'unknown_route',
  'invalid_request',
  'invalid_params',
  'internal_error'
] as const

/** Codes the CLI raises on its own side, before or instead of a route call. */
export const CLIENT_ERROR_CODES = [
  'invalid_usage',
  'app_not_running',
  'launch_failed',
  'transport_error'
] as const

export const ERROR_CODES = [...WIRE_ERROR_CODES, ...CLIENT_ERROR_CODES] as const

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number]
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface RouteError {
  code: ErrorCode
  message: string
}

export interface RouteRequest {
  id: string
  route: string
  params?: unknown
}

export interface RouteSuccess {
  id: string
  ok: true
  payload: unknown
}

export interface RouteFailure {
  id: string
  ok: false
  error: RouteError
}

export type RouteResponse = RouteSuccess | RouteFailure

export function success(id: string, payload: unknown): RouteSuccess {
  return { id, ok: true, payload }
}

export function failure(id: string, code: ErrorCode, message: string): RouteFailure {
  return { id, ok: false, error: { code, message } }
}

/**
 * One message, one line. `JSON.stringify` escapes newlines inside strings, so the only
 * newline in the result is the terminator.
 */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/** Splits a byte stream into whole lines, holding a partial line back for the next chunk. */
export class LineBuffer {
  private rest = ''

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n')
    this.rest = parts.pop() ?? ''
    return parts.filter((line) => line.length > 0)
  }
}

export type ParseResult<T, K extends string> =
  ({ ok: true } & Record<K, T>) | { ok: false; error: RouteError }

function malformed(message: string): { ok: false; error: RouteError } {
  return { ok: false, error: { code: 'invalid_request', message } }
}

function asObject(line: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/**
 * Validates the envelope only. An undeclared route name parses fine here and is refused
 * by the table, so the two failures stay distinguishable: `invalid_request` means the
 * caller sent nonsense, `unknown_route` means it asked for something that is not there.
 */
export function parseRequestLine(line: string): ParseResult<RouteRequest, 'request'> {
  const object = asObject(line)
  if (!object) return malformed('request is not a JSON object')
  if (typeof object.id !== 'string' || object.id.length === 0) {
    return malformed('request has no id')
  }
  if (typeof object.route !== 'string' || object.route.length === 0) {
    return malformed('request has no route')
  }
  return { ok: true, request: { id: object.id, route: object.route, params: object.params } }
}

export function parseResponseLine(line: string): ParseResult<RouteResponse, 'response'> {
  const object = asObject(line)
  if (!object) return malformed('response is not a JSON object')
  if (typeof object.id !== 'string') return malformed('response has no id')
  if (object.ok === true) {
    return { ok: true, response: { id: object.id, ok: true, payload: object.payload } }
  }
  if (object.ok === false) {
    const error = object.error as RouteError | undefined
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
      return malformed('failed response has no error')
    }
    return { ok: true, response: { id: object.id, ok: false, error } }
  }
  return malformed('response is neither a success nor a failure')
}

/**
 * The CLI's exit code for an error code. 0 is success and is not reachable from here;
 * 4 (denied by permission tier) and 5 (paused by user) belong to Phase 6 and stay unused.
 */
export function exitCodeFor(code: ErrorCode): 1 | 2 | 3 {
  if (code === 'invalid_usage') return 2
  if (code === 'app_not_running') return 3
  return 1
}
