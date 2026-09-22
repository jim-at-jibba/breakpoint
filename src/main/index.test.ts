import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Dispatch } from './routes'

/** A launch is the command line, whichever way the argv reached the app. */
function launchCall(path: string): Parameters<Dispatch> {
  return [{ id: 'launch', route: 'project.open', params: { path } }, { surface: 'cli' }]
}

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  app: {
    setName: vi.fn(),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn((): boolean => true),
    on: vi.fn(),
    whenReady: vi.fn((): Promise<void> => Promise.resolve()),
    quit: vi.fn(),
    exit: vi.fn()
  },
  createWindow: vi.fn(),
  window: {
    on: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn() },
    loadFile: vi.fn(),
    isMinimized: (): boolean => false,
    show: vi.fn(),
    focus: vi.fn()
  },
  dispatch: vi.fn<Dispatch>(),
  closeSocket: vi.fn(),
  startSocket: vi.fn()
}))

vi.mock('electron', () => ({
  app: mocks.app,
  shell: {},
  BrowserWindow: class {
    on = mocks.window.on
    webContents = mocks.window.webContents
    loadFile = mocks.window.loadFile

    constructor() {
      mocks.createWindow()
    }

    static getAllWindows(): (typeof mocks.window)[] {
      return [mocks.window]
    }
  }
}))
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: false }
}))
vi.mock('../../resources/icon.png?asset', () => ({ default: 'icon.png' }))
vi.mock('./adapters/ipc', () => ({ registerIpcAdapter: vi.fn() }))
vi.mock('./adapters/socket', () => ({ startSocketAdapter: mocks.startSocket }))
vi.mock('./routes', () => ({ createRouteTable: vi.fn(), createDispatch: () => mocks.dispatch }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.createWindow.mockReset()
  mocks.listeners.clear()
  mocks.app.on.mockImplementation((event: string, listener: (...args: unknown[]) => void): void => {
    mocks.listeners.set(event, listener)
  })
  mocks.dispatch.mockResolvedValue({ response: { id: 'launch', ok: true, data: null } })
  mocks.startSocket.mockResolvedValue({ socketPath: 'test.sock', close: mocks.closeSocket })
  vi.spyOn(console, 'log').mockImplementation((): void => {})
  vi.spyOn(console, 'error').mockImplementation((): void => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('logs, releases the socket and exits nonzero when window creation fails after readiness', async () => {
  const failure = new Error('window creation failed')
  mocks.createWindow.mockImplementation((): never => {
    throw failure
  })

  await import('./index')

  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(1))
  expect(console.error).toHaveBeenCalledWith('[breakpoint] startup failed:', failure)
  expect(mocks.closeSocket).toHaveBeenCalledOnce()
})

it('still exits nonzero if startup socket cleanup also fails', async () => {
  const failure = new Error('window creation failed')
  const cleanupFailure = new Error('socket cleanup failed')
  mocks.createWindow.mockImplementation((): never => {
    throw failure
  })
  mocks.closeSocket.mockImplementationOnce((): never => {
    throw cleanupFailure
  })

  await import('./index')

  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(1))
  expect(console.error).toHaveBeenCalledWith('[breakpoint] startup failed:', failure)
  expect(console.error).toHaveBeenCalledWith('[breakpoint] socket cleanup failed:', cleanupFailure)
})

it('also handles a readiness rejection before initializing the socket', async () => {
  const failure = new Error('readiness failed')
  mocks.app.whenReady.mockRejectedValueOnce(failure)

  await import('./index')

  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(1))
  expect(console.error).toHaveBeenCalledWith('[breakpoint] startup failed:', failure)
  expect(mocks.startSocket).not.toHaveBeenCalled()
})

it('queues native opens before readiness and dispatches them in order after creating the window', async () => {
  let ready: () => void = (): void => {
    throw new Error('readiness promise not initialized')
  }
  mocks.app.whenReady.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      ready = resolve
    })
  )
  await import('./index')

  const preventDefault = vi.fn()
  const listener = mocks.listeners.get('open-file')
  expect(listener).toBeDefined()
  listener?.({ preventDefault }, '/repos/shop')
  listener?.({ preventDefault }, '/repos/other')
  expect(preventDefault).toHaveBeenCalledTimes(2)
  expect(mocks.dispatch).not.toHaveBeenCalled()
  expect(mocks.createWindow).not.toHaveBeenCalled()

  ready()
  await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(2))
  expect(mocks.createWindow).toHaveBeenCalledOnce()
  expect(mocks.dispatch).toHaveBeenNthCalledWith(1, ...launchCall('/repos/shop'))
  expect(mocks.dispatch).toHaveBeenNthCalledWith(2, ...launchCall('/repos/other'))
})

it('opens a native request in the ready app and focuses its window', async () => {
  await import('./index')
  await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce())

  const preventDefault = vi.fn()
  mocks.listeners.get('open-file')?.({ preventDefault }, '/repos/shop')
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.dispatch).toHaveBeenCalledWith(...launchCall('/repos/shop'))
  expect(mocks.window.focus).toHaveBeenCalledOnce()
})
