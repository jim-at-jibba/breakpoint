import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  LineBuffer,
  FrameTooLargeError,
  UNADDRESSED_ID,
  encodeLine,
  failure,
  parseRequestLine
} from '../../shared/protocol'
import type { Dispatch } from '../routes'

/**
 * The CLI's adapter: a unix domain socket (a named pipe on Windows) speaking
 * newline-delimited JSON, one request to one response. Like the IPC adapter it holds no
 * behaviour — it parses a line, calls the route table, and writes the answer back.
 *
 * The socket lives in the app's user data directory with owner-only permissions. A
 * same-user process can already read that directory, so this widens nothing
 * ([ADR-0008]).
 */

export interface SocketAdapter {
  readonly socketPath: string
  /**
   * Synchronous on purpose. `will-quit` cannot be made to wait — preventing the quit to
   * finish an async close and then calling `app.quit()` again does not resume the
   * sequence, it strands the process. The only thing worth undoing is the socket file,
   * and `rmSync` does that in time.
   */
  close(): void
}

export async function startSocketAdapter(
  socketPath: string,
  dispatch: Dispatch
): Promise<SocketAdapter> {
  const isPipe = socketPath.startsWith('\\\\')

  if (!isPipe) {
    mkdirSync(dirname(socketPath), { recursive: true })
    // Only reachable with the single-instance lock held, so any file already here was
    // left by a process that is gone.
    if (existsSync(socketPath)) rmSync(socketPath, { force: true })
  }

  const connections = new Set<Socket>()
  const server = createServer((connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    handleConnection(connection, dispatch)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  if (!isPipe) chmodSync(socketPath, 0o600)

  server.on('error', (error) => {
    console.error('[breakpoint] socket server error:', error)
  })

  return {
    socketPath,
    close: () => closeServer(server, connections, isPipe ? undefined : socketPath)
  }
}

function handleConnection(connection: Socket, dispatch: Dispatch): void {
  const lines = new LineBuffer()
  connection.setEncoding('utf8')
  connection.on('error', () => connection.destroy())

  connection.on('data', (chunk: string) => {
    let received: string[]
    try {
      received = lines.push(chunk)
    } catch (error) {
      if (!(error instanceof FrameTooLargeError)) throw error
      connection.destroy()
      return
    }
    for (const line of received) {
      void respond(connection, dispatch, line)
    }
  })
}

async function respond(connection: Socket, dispatch: Dispatch, line: string): Promise<void> {
  const parsed = parseRequestLine(line)
  if (!parsed.ok) {
    write(connection, failure(UNADDRESSED_ID, parsed.error.code, parsed.error.message))
    return
  }

  const { response, afterRespond } = await dispatch(parsed.request)
  write(connection, response, afterRespond)
}

function write(connection: Socket, response: unknown, afterRespond?: () => void): void {
  if (connection.destroyed) return
  // The callback fires once the line has left this process, which is what lets `app.quit`
  // reply before it shuts the process down.
  connection.write(encodeLine(response), () => afterRespond?.())
}

function closeServer(
  server: Server,
  connections: Set<Socket>,
  socketPath: string | undefined
): void {
  // A CLI that has its answer and has not hung up yet must not hold the listener open.
  for (const connection of connections) connection.destroy()
  connections.clear()

  server.close()
  server.unref()
  if (socketPath) rmSync(socketPath, { force: true })
}
