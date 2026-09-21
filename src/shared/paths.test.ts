import { describe, expect, it } from 'vitest'
import { APP_NAME, resolveSocketPath, resolveUserDataDir } from './paths'

const home = '/Users/dev'

describe('resolveUserDataDir', () => {
  it('follows Electron on macOS', () => {
    expect(resolveUserDataDir({ platform: 'darwin', env: {}, homedir: home })).toBe(
      `${home}/Library/Application Support/${APP_NAME}`
    )
  })

  it('follows XDG on Linux', () => {
    expect(resolveUserDataDir({ platform: 'linux', env: {}, homedir: home })).toBe(
      `${home}/.config/${APP_NAME}`
    )
    expect(
      resolveUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homedir: home })
    ).toBe(`/xdg/${APP_NAME}`)
  })

  it('follows APPDATA on Windows', () => {
    expect(
      resolveUserDataDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
        homedir: home
      })
    ).toBe(`C:\\Users\\dev\\AppData\\Roaming\\${APP_NAME}`)
  })

  it('lets BREAKPOINT_USER_DATA win, so a test run cannot reach a real app', () => {
    expect(
      resolveUserDataDir({
        platform: 'darwin',
        env: { BREAKPOINT_USER_DATA: '/tmp/run' },
        homedir: home
      })
    ).toBe('/tmp/run')
  })
})

describe('resolveSocketPath', () => {
  it('sits in the user data directory on a unix platform', () => {
    expect(resolveSocketPath({ platform: 'darwin', env: {}, homedir: home })).toBe(
      `${home}/Library/Application Support/${APP_NAME}/breakpoint.sock`
    )
  })

  it('is a named pipe on Windows, keyed by the user data directory', () => {
    const env = { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }
    const path = resolveSocketPath({ platform: 'win32', env, homedir: home })
    expect(path).toMatch(/^\\\\\.\\pipe\\breakpoint-[0-9a-f]{16}$/)
    expect(resolveSocketPath({ platform: 'win32', env, homedir: home })).toBe(path)
  })

  it('gives two user data directories two different pipes', () => {
    const a = resolveSocketPath({ platform: 'win32', env: { APPDATA: 'C:\\a' }, homedir: home })
    const b = resolveSocketPath({ platform: 'win32', env: { APPDATA: 'C:\\b' }, homedir: home })
    expect(a).not.toBe(b)
  })

  it('lets BREAKPOINT_SOCKET win outright', () => {
    expect(
      resolveSocketPath({
        platform: 'darwin',
        env: { BREAKPOINT_SOCKET: '/tmp/x.sock' },
        homedir: home
      })
    ).toBe('/tmp/x.sock')
  })
})
