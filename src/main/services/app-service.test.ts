import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StateFeed } from '../state-feed'
import type { ThemeHost } from '../theme-host'
import type { AppSettings } from '../../shared/settings'
import type { RevisionedPatch } from '../../shared/state'
import type { AppTheme, ThemePreference } from '../../shared/theme'
import type { LoadSettingsResult, SettingsStore } from './settings-store'

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

/**
 * The platform, as the service is allowed to see it: `themeSource` overrides what the OS
 * says, and the platform announces every change to either.
 */
class FakeThemeHost implements ThemeHost {
  system: AppTheme = 'dark'
  preference: ThemePreference = 'system'
  readonly painted: AppTheme[] = []
  private readonly listeners = new Set<() => void>()

  apply(preference: ThemePreference): AppTheme {
    this.preference = preference
    this.announce()
    return this.theme()
  }

  theme(): AppTheme {
    return this.preference === 'system' ? this.system : this.preference
  }

  paint(theme: AppTheme): void {
    this.painted.push(theme)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The developer changing the OS appearance while the app is running. */
  setSystem(theme: AppTheme): void {
    this.system = theme
    this.announce()
  }

  private announce(): void {
    for (const listener of this.listeners) listener()
  }
}

class FakeSettingsStore {
  readonly file = '/data/settings.json'
  readonly saved: AppSettings[] = []
  save: (settings: AppSettings) => Promise<void>

  constructor(private readonly result: LoadSettingsResult) {
    this.save = (settings) => {
      this.saved.push(settings)
      return Promise.resolve()
    }
  }

  load(): Promise<LoadSettingsResult> {
    return Promise.resolve(this.result)
  }
}

interface Harness {
  app: AppService
  createWindow: ReturnType<typeof vi.fn>
  host: FakeThemeHost
  store: FakeSettingsStore
  patches: RevisionedPatch[]
}

function harness(stored: LoadSettingsResult = { status: 'missing' }): Harness {
  const createWindow = vi.fn()
  const host = new FakeThemeHost()
  const store = new FakeSettingsStore(stored)
  const feed = new StateFeed()
  const patches: RevisionedPatch[] = []
  feed.subscribe((patch) => patches.push(patch))
  const app = new AppService(createWindow, store as unknown as SettingsStore, feed, host)
  return { app, createWindow, host, store, patches }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.windows.length = 0
})

it('creates a window when the app is alive without one', () => {
  const { app, createWindow } = harness()

  expect(app.focus()).toEqual({ focused: true })

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
  const { app, createWindow } = harness()

  expect(app.focus()).toEqual({ focused: true })

  expect(createWindow).not.toHaveBeenCalled()
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
  expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true })
})

describe('the app theme', () => {
  it('follows the OS until the developer says otherwise', async () => {
    const { app, host } = harness()
    host.system = 'light'

    await app.load()

    expect(app.theme()).toEqual({ preference: 'system', active: 'light' })
    expect(host.preference).toBe('system')
  })

  it('restores the override from the last run rather than the OS', async () => {
    const { app, host } = harness({ status: 'loaded', settings: { theme: 'dark' } })
    host.system = 'light'

    await app.load()

    expect(app.theme()).toEqual({ preference: 'dark', active: 'dark' })
    // Handed to the platform, so Electron's own surfaces and every renderer follow.
    expect(host.preference).toBe('dark')
  })

  it('announces nothing at load: the snapshot every surface fetches already carries it', async () => {
    const { app, patches } = harness({ status: 'loaded', settings: { theme: 'light' } })

    await app.load()

    expect(patches).toEqual([])
  })

  it('keeps an override, tells the platform, and announces it once', async () => {
    const { app, host, store, patches } = harness()
    await app.load()

    await expect(app.setTheme('light')).resolves.toEqual({ preference: 'light', active: 'light' })

    expect(store.saved).toEqual([{ theme: 'light' }])
    expect(host.preference).toBe('light')
    expect(patches).toEqual([
      { revision: 1, patch: { type: 'app.theme', theme: { preference: 'light', active: 'light' } } }
    ])
  })

  it('announces a preference that changes without the chrome changing', async () => {
    const { app, patches, host } = harness()
    host.system = 'dark'
    await app.load()

    // System already resolves to dark; pinning it is still a change the control draws.
    await app.setTheme('dark')

    expect(patches).toEqual([
      { revision: 1, patch: { type: 'app.theme', theme: { preference: 'dark', active: 'dark' } } }
    ])
  })

  it('paints the open windows, which is what shows before a renderer has', async () => {
    const { app, host } = harness()
    await app.load()

    await app.setTheme('light')

    expect(host.painted).toEqual(['light'])
  })

  it('follows the OS live while the preference is system', async () => {
    const { app, host, patches } = harness()
    await app.load()

    host.setSystem('light')

    expect(app.theme()).toEqual({ preference: 'system', active: 'light' })
    expect(patches).toEqual([
      {
        revision: 1,
        patch: { type: 'app.theme', theme: { preference: 'system', active: 'light' } }
      }
    ])
  })

  it('ignores the OS while the developer has overridden it', async () => {
    const { app, host, patches } = harness({ status: 'loaded', settings: { theme: 'dark' } })
    await app.load()

    host.setSystem('light')

    expect(app.theme()).toEqual({ preference: 'dark', active: 'dark' })
    expect(patches).toEqual([])
  })

  it('says nothing when the platform reports an appearance it already has', async () => {
    const { app, host, patches } = harness()
    await app.load()

    host.setSystem('dark')

    expect(patches).toEqual([])
  })

  it('refuses to set a theme over a settings file it could not read', async () => {
    const { app, store, patches } = harness({
      status: 'refused',
      reason: 'corrupt',
      message: 'the file is not JSON'
    })
    await app.load()

    await expect(app.setTheme('light')).rejects.toMatchObject({ code: 'SETTINGS_UNREADABLE' })

    expect(store.saved).toEqual([])
    expect(patches).toEqual([])
    // The chrome is still the OS's, which is the answer that needs nothing stored.
    expect(app.theme()).toEqual({ preference: 'system', active: 'dark' })
  })

  it('does not announce a theme it could not keep', async () => {
    const { app, store, host, patches } = harness()
    await app.load()
    store.save = (): Promise<void> => Promise.reject(new Error('disk full'))

    await expect(app.setTheme('light')).rejects.toThrow('disk full')

    expect(patches).toEqual([])
    expect(host.preference).toBe('system')
  })
})
