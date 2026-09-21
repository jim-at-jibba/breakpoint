/**
 * The request and response envelope both adapters carry, and the stable error codes
 * they report. The socket writes these as newline-delimited JSON, one request to one
 * response; IPC passes the same objects structured-cloned.
 */

/**
 * Codes a route call can come back with. These travel over the wire.
 *
 * Stable strings in the spelling #6 settled: the message beside them is for humans and
 * may be reworded freely, the code may not. Codes are declared by the tickets that can
 * raise them, not guessed at ahead of time.
 */
export const WIRE_ERROR_CODES = [
  'UNKNOWN_ROUTE',
  'INVALID_REQUEST',
  'INVALID_PARAMS',
  'INTERNAL_ERROR',
  /** The project's file is on disk but this build will not load it: corrupt, or newer. */
  'PROJECT_UNREADABLE',
  /** No pane with that id in the open project, or no project open. */
  'PANE_NOT_FOUND'
] as const

/** Codes a surface raises on its own side, before or instead of a route call. */
export const SURFACE_ERROR_CODES = [
  'INVALID_USAGE',
  'APP_NOT_RUNNING',
  'LAUNCH_FAILED',
  'TIMEOUT',
  'TRANSPORT_ERROR'
] as const

export const ERROR_CODES = [...WIRE_ERROR_CODES, ...SURFACE_ERROR_CODES] as const

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number]
export type SurfaceErrorCode = (typeof SURFACE_ERROR_CODES)[number]
export type ErrorCode = (typeof ERROR_CODES)[number]

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES)

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value)
}

/**
 * Stands in for the id of a request we could not read one from. A reply still has to be
 * addressed, and refusing to answer at all would leave the caller waiting.
 */
export const UNADDRESSED_ID = '0'

export interface RouteError {
  code: ErrorCode
  /** For humans. Nothing should branch on it; that is what the code is for. */
  message: string
  details?: unknown
}

export interface RouteRequest {
  id: string
  route: string
  params?: unknown
}

export interface RouteSuccess<T = unknown> {
  id: string
  ok: true
  /** The route's payload. Named `data` on the wire, per the contract #6 settled. */
  data: T
}

export interface RouteFailure {
  id: string
  ok: false
  error: RouteError
}

export type RouteResponse<T = unknown> = RouteSuccess<T> | RouteFailure

export function success<T>(id: string, data: T): RouteSuccess<T> {
  return { id, ok: true, data }
}

export function failure(
  id: string,
  code: ErrorCode,
  message: string,
  details?: unknown
): RouteFailure {
  return {
    id,
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details }
  }
}

/**
 * One message, one line. `JSON.stringify` escapes newlines inside strings, so the only
 * newline in the result is the terminator.
 */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_REQUEST_ID_BYTES = 1024

const UTF8_ENCODER = new TextEncoder()

export function jsonByteLength(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength
}

export class FrameTooLargeError extends Error {
  constructor() {
    super(`frame exceeds the ${MAX_FRAME_BYTES}-byte limit`)
  }
}

/** The limit excludes the newline and counts UTF-8 bytes, not JavaScript characters. */
export class LineBuffer {
  private fragments: string[] = []
  private bytes = 0

  push(chunk: string): string[] {
    const lines: string[] = []
    let start = 0

    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start)
      const end = newline === -1 ? chunk.length : newline
      const fragment = chunk.slice(start, end)
      const fragmentBytes =
        fragment.length > MAX_FRAME_BYTES
          ? fragment.length
          : UTF8_ENCODER.encode(fragment).byteLength
      if (this.bytes + fragmentBytes > MAX_FRAME_BYTES) {
        this.fragments = []
        this.bytes = 0
        throw new FrameTooLargeError()
      }
      if (fragment.length > 0) {
        this.fragments.push(fragment)
        this.bytes += fragmentBytes
      }
      if (newline === -1) break
      if (this.bytes > 0) lines.push(this.fragments.join(''))
      this.fragments = []
      this.bytes = 0
      start = newline + 1
    }

    return lines
  }
}

export type ParsedRequest = { ok: true; request: RouteRequest } | { ok: false; error: RouteError }

export type ParsedResponse =
  { ok: true; response: RouteResponse } | { ok: false; error: RouteError }

function malformed(message: string): { ok: false; error: RouteError } {
  return { ok: false, error: { code: 'INVALID_REQUEST', message } }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Validates the envelope only. An undeclared route name parses fine here and is refused
 * by the table, so the two failures stay distinguishable: `INVALID_REQUEST` means the
 * caller sent nonsense, `UNKNOWN_ROUTE` means it asked for something that is not there.
 *
 * Both adapters go through this, so a socket call and an IPC call fail identically.
 */
export function parseRequest(value: unknown): ParsedRequest {
  const object = asObject(value)
  if (!object) return malformed('request is not a JSON object')
  if (typeof object.id !== 'string' || object.id.length === 0) {
    return malformed('request has no id')
  }
  if (jsonByteLength(object.id) > MAX_REQUEST_ID_BYTES) {
    return malformed(`request id exceeds the ${MAX_REQUEST_ID_BYTES}-byte JSON limit`)
  }
  if (typeof object.route !== 'string' || object.route.length === 0) {
    return malformed('request has no route')
  }
  return { ok: true, request: { id: object.id, route: object.route, params: object.params } }
}

export function parseRequestLine(line: string): ParsedRequest {
  return parseRequest(parseJson(line))
}

export function parseResponseLine(line: string): ParsedResponse {
  const object = asObject(parseJson(line))
  if (!object) return malformed('response is not a JSON object')
  if (typeof object.id !== 'string') return malformed('response has no id')
  if (object.ok === true) {
    return { ok: true, response: { id: object.id, ok: true, data: object.data } }
  }
  if (object.ok === false) {
    const error = asObject(object.error)
    if (!error || typeof error.message !== 'string') {
      return malformed('failed response has no error')
    }
    if (!isErrorCode(error.code)) return malformed('failed response has an unknown error code')
    return {
      ok: true,
      response: failure(object.id, error.code, error.message, error.details)
    }
  }
  return malformed('response is neither a success nor a failure')
}

/**
 * The CLI's exit code for an error code. 0 is success and is not reachable from here;
 * 4 (denied by permission tier) and 5 (paused by user) belong to Phase 6 and stay unused.
 */
export function exitCodeFor(code: ErrorCode): 1 | 2 | 3 {
  if (code === 'INVALID_USAGE') return 2
  if (code === 'APP_NOT_RUNNING') return 3
  return 1
}
