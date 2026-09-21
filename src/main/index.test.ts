import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
  closeSocket: vi.fn(),
  startSocket: vi.fn()
}))

vi.mock('electron', () => ({
  app: mocks.app,
  shell: {},
  BrowserWindow: class {
    constructor() {
      mocks.createWindow()
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

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
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
