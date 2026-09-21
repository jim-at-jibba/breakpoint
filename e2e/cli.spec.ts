import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { BreakpointBridge } from '../src/shared/ipc'
import {
  closeApp,
  isRunning,
  launchApp,
  MAIN_ENTRY,
  requestLine,
  runCli,
  Sandbox,
  sendRaw,
  waitFor,
  waitForExit,
  type LaunchedApp
} from './harness'

/** `src/preload/index.d.ts` augments the renderer's global; this project does not see it. */
type BridgeWindow = Window & { breakpoint: BreakpointBridge }

let sandbox: Sandbox
let launched: LaunchedApp | undefined

test.beforeEach(() => {
  sandbox = new Sandbox()
  launched = undefined
})

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  sandbox.dispose()
})

test('quit closes a running app and exits 0', async () => {
  launched = await launchApp(sandbox)

  const run = await runCli(sandbox, ['quit'])

  expect(run.code).toBe(0)
  expect(run.stdout).toBe('Breakpoint is quitting.\n')
  // Not just the socket: the process itself has to be gone, or `quit` is a lie.
  await waitForExit(launched)
  expect(existsSync(sandbox.socketPath)).toBe(false)
  launched = undefined
})

test('quit --no-launch with nothing running exits 3 and starts nothing', async () => {
  const run = await runCli(sandbox, ['quit', '--no-launch'])

  expect(run.code).toBe(3)
  expect(run.stdout).toBe('')
  expect(run.stderr).toContain('not running')
  expect(existsSync(sandbox.socketPath)).toBe(false)
})

test('quit with nothing running starts the app, then quits it', async () => {
  const run = await runCli(sandbox, ['quit', '--verbose'])

  expect(run.code).toBe(0)
  expect(run.stderr).toContain('starting the app')
  await waitFor(() => !existsSync(sandbox.socketPath), 'the launched app to release its socket')
  await waitFor(() => !isRunning(sandbox), 'the launched app to exit')
})

test('an unknown route comes back as unknown_route over the socket', async () => {
  launched = await launchApp(sandbox)

  const response = await sendRaw(sandbox.socketPath, requestLine('nope.nope'))

  expect(response.ok).toBe(false)
  expect(response.ok === false && response.error.code).toBe('unknown_route')
})

test('a malformed envelope comes back as invalid_request, not as a crash', async () => {
  launched = await launchApp(sandbox)

  const response = await sendRaw(sandbox.socketPath, '{ not json')

  expect(response.ok === false && response.error.code).toBe('invalid_request')
  // The connection survived it well enough to answer a real request afterwards.
  const after = await sendRaw(sandbox.socketPath, requestLine('nope.nope'))
  expect(after.ok === false && after.error.code).toBe('unknown_route')
})

test('params a route does not take come back as invalid_params', async () => {
  launched = await launchApp(sandbox)

  const response = await sendRaw(sandbox.socketPath, requestLine('app.quit', { force: true }))

  expect(response.ok === false && response.error.code).toBe('invalid_params')
})

test('an unparseable argument exits 2 without reaching the app', async () => {
  launched = await launchApp(sandbox)

  const unknownCommand = await runCli(sandbox, ['frobnicate'])
  const unknownFlag = await runCli(sandbox, ['quit', '--turbo'])

  expect(unknownCommand.code).toBe(2)
  expect(unknownCommand.stdout).toBe('')
  expect(unknownFlag.code).toBe(2)
  expect(unknownFlag.stdout).toBe('')
  expect(existsSync(sandbox.socketPath)).toBe(true)
})

test('--json puts the payload on stdout alone, even in a verbose run', async () => {
  launched = await launchApp(sandbox)

  const run = await runCli(sandbox, ['quit', '--json', '--verbose'])

  expect(run.code).toBe(0)
  // Exactly the payload object, so a `jq` pipe sees JSON and nothing else.
  expect(JSON.parse(run.stdout)).toEqual({ quitting: true })
  expect(run.stdout).toBe('{"quitting":true}\n')
  expect(run.stderr).toContain('breakpoint:')
  await waitForExit(launched)
  launched = undefined
})

test('a second launch focuses the existing window and hands over its argv', async () => {
  launched = await launchApp(sandbox)
  const { app, output } = launched

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  await waitFor(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
    'the window to minimise'
  )

  const second = spawn(app.process().spawnfile, [MAIN_ENTRY, '--handed-over', '/tmp/some-repo'], {
    env: sandbox.env,
    stdio: 'ignore'
  })
  const secondExit = await new Promise<number>((resolve) => {
    second.once('close', (code) => resolve(code ?? -1))
  })

  // The second copy took the hand-off and got out of the way rather than opening a window.
  expect(secondExit).toBe(0)
  await waitFor(() => output().includes('second-instance'), 'the argv hand-off to be announced')
  expect(output()).toContain('--handed-over')
  expect(output()).toContain('/tmp/some-repo')

  await waitFor(
    async () =>
      !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())),
    'the existing window to be restored'
  )
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('the renderer reaches the same route table over typed IPC', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  // The same undeclared name the socket refuses, refused the same way. One table.
  const overIpc = await page.evaluate(() =>
    (window as unknown as BridgeWindow).breakpoint.invoke('nope.nope' as 'app.quit')
  )
  const overSocket = await sendRaw(sandbox.socketPath, requestLine('nope.nope'))

  expect(overIpc.ok).toBe(false)
  expect(overIpc.ok === false && overIpc.error.code).toBe('unknown_route')
  expect(overIpc.ok === false && overIpc.error.code).toBe(
    overSocket.ok === false ? overSocket.error.code : undefined
  )
})

test('the renderer causes app.quit, and the app quits', async () => {
  launched = await launchApp(sandbox)
  const page = await launched.app.firstWindow()

  await page.getByRole('button', { name: 'Quit' }).click()

  await waitForExit(launched)
  expect(existsSync(sandbox.socketPath)).toBe(false)
  launched = undefined
})
