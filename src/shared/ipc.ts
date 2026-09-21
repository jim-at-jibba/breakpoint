import type { RouteResponse } from './protocol'
import type { RouteName, RouteParams, RoutePayload } from './routes'

/**
 * The one IPC channel. The renderer never names an Electron channel per feature; it
 * sends a route envelope down this one and the IPC adapter hands it to the same route
 * table the socket adapter uses.
 */
export const ROUTE_CHANNEL = 'breakpoint:route'

/**
 * What the preload exposes on `window.breakpoint`. The only thing the renderer can ask
 * for is a route the shared module declares, and what comes back is the same envelope
 * the CLI reads off the socket.
 */
export interface BreakpointBridge {
  invoke<N extends RouteName>(
    route: N,
    params?: RouteParams<N>
  ): Promise<RouteResponse<RoutePayload<N>>>
}
