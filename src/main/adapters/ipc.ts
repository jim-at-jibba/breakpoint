import { ipcMain } from 'electron'
import { ROUTE_CHANNEL } from '../../shared/ipc'
import { UNADDRESSED_ID, failure, parseRequest, type RouteResponse } from '../../shared/protocol'
import type { Dispatch } from '../routes'

/**
 * The renderer's adapter. It holds no behaviour: it validates the envelope the renderer
 * sent and hands it to the route table.
 *
 * The renderer is trusted code, but the envelope goes through the same parser the socket
 * uses, so an IPC call and a socket call fail the same way with the same code.
 */
export function registerIpcAdapter(dispatch: Dispatch): void {
  ipcMain.handle(ROUTE_CHANNEL, async (_event, raw: unknown): Promise<RouteResponse> => {
    const parsed = parseRequest(raw)
    if (!parsed.ok) {
      return failure(UNADDRESSED_ID, parsed.error.code, parsed.error.message)
    }

    const { response, afterRespond } = await dispatch(parsed.request)
    // Electron serialises the return value before this handler's promise settles for the
    // renderer, so the reply is safely gone by the time anything here runs.
    if (afterRespond) setImmediate(afterRespond)
    return response
  })
}
