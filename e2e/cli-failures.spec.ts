import { once } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { encodeLine, failure, MAX_FRAME_BYTES } from '../src/shared/protocol'
import { runCli, Sandbox } from './harness'

interface FakeServerOptions {
  socketPath: string
  onConnection(connection: Socket): void
}

let sandbox: Sandbox
let server: Server | undefined
const connections = new Set<Socket>()

test.beforeEach(() => {
  sandbox = new Sandbox()
  server = undefined
})

test.afterEach(async () => {
  for (const connection of connections) connection.destroy()
  connections.clear()
  if (server?.listening) {
    const closed = once(server, 'close')
    server.close()
    await closed
  }
  sandbox.dispose()
})

async function listen({ socketPath, onConnection }: FakeServerOptions): Promise<void> {
  server = createServer((connection: Socket): void => {
    connections.add(connection)
    connection.once('close', () => connections.delete(connection))
    connection.on('error', () => connection.destroy())
    onConnection(connection)
  })
  const listening = once(server, 'listening')
  server.listen(socketPath)
  await listening
}

test('a missing app produces a structured error in JSON mode', async () => {
  const result = await runCli(sandbox, ['quit', '--no-launch', '--json'])
  expect(result.code).toBe(3)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'APP_NOT_RUNNING', message: 'the app is not running' }
  })
})

test('a usage error honours JSON mode even when the flag follows the mistake', async () => {
  const result = await runCli(sandbox, ['quit', '--turbo', '--json'])
  expect(result.code).toBe(2)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'INVALID_USAGE', message: 'unknown flag --turbo' }
  })
})

test('an inherited socket override cannot direct the CLI outside its sandbox', async () => {
  const inheritedSocket = join(sandbox.userDataDir, 'other.sock')
  let accepted = 0
  await listen({
    socketPath: inheritedSocket,
    onConnection(connection: Socket): void {
      accepted += 1
      connection.end(encodeLine({ id: '1', ok: true, data: { quitting: true } }))
    }
  })
  const previous = process.env.BREAKPOINT_SOCKET
  process.env.BREAKPOINT_SOCKET = inheritedSocket

  try {
    expect(sandbox.env.BREAKPOINT_SOCKET).toBe(sandbox.socketPath)
    const result = await runCli(sandbox, ['quit', '--no-launch'])
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(accepted).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.BREAKPOINT_SOCKET
    else process.env.BREAKPOINT_SOCKET = previous
  }
})

test('an oversized unterminated reply produces TRANSPORT_ERROR and closes the connection', async () => {
  await listen({
    socketPath: sandbox.socketPath,
    onConnection(connection: Socket): void {
      connection.once('data', () => connection.write('x'.repeat(MAX_FRAME_BYTES + 1)))
    }
  })

  const result = await runCli(sandbox, ['quit', '--no-launch', '--json'])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'TRANSPORT_ERROR', message: `frame exceeds the ${MAX_FRAME_BYTES}-byte limit` }
  })
  await expect.poll(() => connections.size).toBe(0)
})

test('an undeclared response code becomes a structured TRANSPORT_ERROR', async () => {
  await listen({
    socketPath: sandbox.socketPath,
    onConnection(connection: Socket): void {
      connection.once('data', () => {
        connection.write(
          encodeLine({ id: '1', ok: false, error: { code: 'NOT_DECLARED', message: 'bad' } })
        )
      })
    }
  })

  const result = await runCli(sandbox, ['quit', '--no-launch', '--json'])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'TRANSPORT_ERROR', message: 'failed response has an unknown error code' }
  })
})

test('a route failure uses the same structured error format', async () => {
  await listen({
    socketPath: sandbox.socketPath,
    onConnection(connection: Socket): void {
      connection.once('data', () => {
        connection.write(encodeLine(failure('1', 'INTERNAL_ERROR', 'route failed')))
      })
    }
  })

  const result = await runCli(sandbox, ['quit', '--no-launch', '--json'])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'INTERNAL_ERROR', message: 'route failed' }
  })
})

test('an unresponsive socket produces a structured TIMEOUT', async () => {
  await listen({
    socketPath: sandbox.socketPath,
    onConnection(connection: Socket): void {
      connection.resume()
    }
  })

  const result = await runCli(sandbox, ['quit', '--no-launch', '--json'])
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: 'TIMEOUT', message: 'no response from the app after 10000ms' }
  })
})
