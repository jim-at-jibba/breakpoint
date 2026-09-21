import { ipcMain } from 'electron'
import { ROUTE_CHANNEL } from '../../shared/ipc'
import { failure, type RouteRequest, type RouteResponse } from '../../shared/protocol'
import type { Dispatch } from '../routes'

/**
 * The renderer's adapter. It holds no behaviour: it puts an envelope around what the
 * renderer asked for and hands it to the route table.
 *
 * The renderer is trusted code, but the envelope is validated all the same, so an IPC
 * call and a socket call fail the same way with the same code.
 */
export function registerIpcAdapter(dispatch: Dispatch): void {
  ipcMain.handle(ROUTE_CHANNEL, async (_event, raw: unknown): Promise<RouteResponse> => {
    const request = readRequest(raw)
    if (!request) {
      return failure('0', 'invalid_request', 'request is not a route envelope')
    }

    const { response, afterRespond } = await dispatch(request)
    // Electron serialises the return value before this handler's promise settles for the
    // renderer, so the reply is safely gone by the time anything here runs.
    if (afterRespond) setImmediate(afterRespond)
    return response
  })
}

function readRequest(raw: unknown): RouteRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Partial<RouteRequest>
  if (typeof candidate.route !== 'string' || candidate.route.length === 0) return undefined
  return {
    id: typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : '0',
    route: candidate.route,
    params: candidate.params
  }
}
