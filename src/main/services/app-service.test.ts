import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appFocus: vi.fn(),
  windows: [] as Array<{
    isMinimized: ReturnType<typeof vi.fn<() => boolean>>
    restore: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', () => ({
  app: { focus: mocks.appFocus, quit: vi.fn() },
  BrowserWindow: {
    getAllWindows: (): typeof mocks.windows => mocks.windows
  }
}))

import { AppService } from './app-service'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.windows.length = 0
})

it('creates a window when the app is alive without one', () => {
  const createWindow = vi.fn()

  expect(new AppService(createWindow).focus()).toEqual({ focused: true })

  expect(createWindow).toHaveBeenCalledOnce()
})

it('restores and activates an existing window', () => {
  const window = {
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }
  mocks.windows.push(window)
  const createWindow = vi.fn()

  expect(new AppService(createWindow).focus()).toEqual({ focused: true })

  expect(createWindow).not.toHaveBeenCalled()
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
  expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true })
})
