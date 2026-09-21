import type { WireErrorCode } from '../shared/protocol'

/**
 * A failure a service wants reported with a specific code. Anything else a handler
 * throws is `INTERNAL_ERROR`, so a service reaches for this only when the caller can
 * branch on the difference.
 */
export class RouteError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
  }
}
