import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  affectedCapabilities,
  applyEmulation,
  emulationFor,
  type EmulationCommand
} from './emulation'

const CHROME = '140.0.7339.41'

// The hosts a desktop pane can find itself on. Every test that does not care which one it
// is on says MAC, because that is what the suite has always implicitly assumed.
const MAC = { platform: 'darwin', arch: 'arm64' } as const
const MAC_INTEL = { platform: 'darwin', arch: 'x64' } as const
const WINDOWS = { platform: 'win32', arch: 'x64' } as const
const LINUX = { platform: 'linux', arch: 'x64' } as const

const phone = {
  width: 390,
  height: 844,
  dpr: 3,
  mobile: true,
  touch: true,
  userAgent: null,
  colorScheme: 'dark' as const
}
const desktop = {
  width: 1440,
  height: 900,
  dpr: 1,
  mobile: false,
  touch: false,
  userAgent: null,
  colorScheme: 'light' as const
}

function command(commands: EmulationCommand[], method: string): EmulationCommand | undefined {
  return commands.find((candidate) => candidate.method === method)
}

describe('the overrides a pane is emulated with', () => {
  it('requires the capability, method and parameters to agree at compile time', () => {
    expectTypeOf<{
      capability: 'touch'
      method: 'Emulation.setEmulatedMedia'
      params: { features: [{ name: 'prefers-color-scheme'; value: 'dark' }] }
    }>().not.toMatchTypeOf<EmulationCommand>()
    expectTypeOf<{
      capability: 'touch'
      method: 'Emulation.setTouchEmulationEnabled'
      params: { enabled: string; maxTouchPoints: number }
    }>().not.toMatchTypeOf<EmulationCommand>()
    expectTypeOf<{
      capability: 'viewport'
      method: 'Emulation.setDeviceMetricsOverride'
      params: { width: number; height: number; mobile: boolean }
    }>().not.toMatchTypeOf<EmulationCommand>()
  })
  it('sets a true CSS viewport at the pane’s DPR, whatever size it is drawn', () => {
    expect(command(emulationFor(phone, CHROME, MAC), 'Emulation.setDeviceMetricsOverride')).toEqual(
      {
        capability: 'viewport',
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
      }
    )
  })

  it('sends a mobile pane as a phone, with client hints that agree', () => {
    const { capability, params } = command(
      emulationFor(phone, CHROME, MAC),
      'Emulation.setUserAgentOverride'
    )!
    expect(capability).toBe('userAgent')
    expect(params).toMatchObject({
      userAgent:
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv81',
      userAgentMetadata: {
        platform: 'Android',
        mobile: true,
        brands: expect.arrayContaining([{ brand: 'Chromium', version: '140' }]),
        fullVersionList: expect.arrayContaining([{ brand: 'Chromium', version: CHROME }])
      }
    })
  })

  it('sends a desktop pane as desktop Chrome, not as Electron', () => {
    const { params } = command(
      emulationFor(desktop, CHROME, MAC),
      'Emulation.setUserAgentOverride'
    )!
    expect(params).toMatchObject({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      userAgentMetadata: { platform: 'macOS', mobile: false }
    })
    expect(JSON.stringify(params)).not.toMatch(/Electron|breakpoint/i)
  })

  it('sends a desktop pane as the host it is running on, not always as a Mac', () => {
    const agent = (host: Parameters<typeof emulationFor>[2]): unknown =>
      command(emulationFor(desktop, CHROME, host), 'Emulation.setUserAgentOverride')!.params

    expect(agent(WINDOWS)).toMatchObject({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      platform: 'Win32',
      userAgentMetadata: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86' }
    })
    expect(agent(LINUX)).toMatchObject({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      // Chrome sends no platform version on Linux.
      userAgentMetadata: { platform: 'Linux', platformVersion: '', architecture: 'x86' }
    })
  })

  it('reports the architecture in the client hints and never in the user agent string', () => {
    const silicon = command(
      emulationFor(desktop, CHROME, MAC),
      'Emulation.setUserAgentOverride'
    )!.params
    const intel = command(
      emulationFor(desktop, CHROME, MAC_INTEL),
      'Emulation.setUserAgentOverride'
    )!.params

    // Chrome's reduced user agent is frozen at `Intel Mac OS X 10_15_7` on Apple silicon
    // too, so the two hosts differ in the hints alone.
    expect(silicon).toMatchObject({ userAgentMetadata: { architecture: 'arm' } })
    expect(intel).toMatchObject({ userAgentMetadata: { architecture: 'x86' } })
    expect((silicon as { userAgent: string }).userAgent).toEqual(
      (intel as { userAgent: string }).userAgent
    )
  })

  it('still prefers the pane’s own user agent to the host’s, on every host', () => {
    const { params } = command(
      emulationFor({ ...desktop, userAgent: 'Kiosk/1.0 (Shelf)' }, CHROME, LINUX),
      'Emulation.setUserAgentOverride'
    )!
    expect(params).toMatchObject({
      userAgent: 'Kiosk/1.0 (Shelf)',
      // The hints still describe the host: a preset carries one user agent, not a hint set.
      userAgentMetadata: { platform: 'Linux' }
    })
  })

  it('sends the pane’s own user agent when it has one, in place of Breakpoint’s', () => {
    const { params } = command(
      emulationFor({ ...phone, userAgent: 'Kiosk/1.0 (Shelf)' }, CHROME, MAC),
      'Emulation.setUserAgentOverride'
    )!
    expect(params).toMatchObject({
      userAgent: 'Kiosk/1.0 (Shelf)',
      // The client hints keep telling the mobile flag's story: a preset carries one user
      // agent, not a full hint set, and a server reading either still sees a phone.
      userAgentMetadata: { platform: 'Android', mobile: true }
    })
  })

  it('emulates touch for a pane that asks for it, whatever its mobile flag says', () => {
    expect(command(emulationFor(phone, CHROME, MAC), 'Emulation.setTouchEmulationEnabled')).toEqual(
      {
        capability: 'touch',
        method: 'Emulation.setTouchEmulationEnabled',
        params: { enabled: true, maxTouchPoints: 5 }
      }
    )
    expect(
      command(
        emulationFor({ ...desktop, touch: true }, CHROME, MAC),
        'Emulation.setTouchEmulationEnabled'
      )?.params
    ).toEqual({ enabled: true, maxTouchPoints: 5 })
  })

  it('disables touch for a pane that does not, with one touch point, since CDP rejects zero even when disabling', () => {
    expect(
      command(emulationFor(desktop, CHROME, MAC), 'Emulation.setTouchEmulationEnabled')?.params
    ).toEqual({ enabled: false, maxTouchPoints: 1 })
    expect(
      command(
        emulationFor({ ...phone, touch: false }, CHROME, MAC),
        'Emulation.setTouchEmulationEnabled'
      )?.params
    ).toEqual({ enabled: false, maxTouchPoints: 1 })
  })

  it('forces the pane’s own colour scheme', () => {
    expect(command(emulationFor(phone, CHROME, MAC), 'Emulation.setEmulatedMedia')).toEqual({
      capability: 'colorScheme',
      method: 'Emulation.setEmulatedMedia',
      params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }
    })
    expect(
      command(emulationFor(desktop, CHROME, MAC), 'Emulation.setEmulatedMedia')?.params
    ).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })
  })

  it('clears the colour scheme override for a system pane', () => {
    expect(
      command(
        emulationFor({ ...phone, colorScheme: 'system' }, CHROME, MAC),
        'Emulation.setEmulatedMedia'
      )?.params
    ).toEqual({ features: [{ name: 'prefers-color-scheme', value: '' }] })
  })

  it('covers every capability once', () => {
    expect(emulationFor(phone, CHROME, MAC).map((entry) => entry.capability)).toEqual([
      'viewport',
      'userAgent',
      'touch',
      'colorScheme'
    ])
  })
})

describe('which capabilities a change invalidates', () => {
  it('maps each declared value to the overrides that carry it', () => {
    expect(affectedCapabilities({ dpr: 2 })).toEqual(['viewport'])
    // The mobile flag is in the viewport override and in the client hints, but no longer
    // in touch: a pane carries its own touch setting once it exists.
    expect(affectedCapabilities({ mobile: true })).toEqual(['viewport', 'userAgent'])
    expect(affectedCapabilities({ touch: true })).toEqual(['touch'])
    expect(affectedCapabilities({ colorScheme: 'dark' })).toEqual(['colorScheme'])
    expect(affectedCapabilities({})).toEqual([])
  })

  it('names a capability once however many changes reach it', () => {
    expect(affectedCapabilities({ dpr: 2, mobile: false, touch: false })).toEqual([
      'viewport',
      'userAgent',
      'touch'
    ])
  })
})

describe('applying the overrides', () => {
  it('reports every capability applied when CDP accepts them all', async () => {
    const sent: string[] = []
    const results = await applyEmulation(emulationFor(phone, CHROME, MAC), async ({ method }) => {
      sent.push(method)
    })
    expect(sent).toHaveLength(4)
    expect(results).toEqual([
      { capability: 'viewport', ok: true },
      { capability: 'userAgent', ok: true },
      { capability: 'touch', ok: true },
      { capability: 'colorScheme', ok: true }
    ])
  })

  it('degrades only the capability CDP rejects, applies the rest, and says why', async () => {
    const sent: string[] = []
    const results = await applyEmulation(emulationFor(desktop, CHROME, MAC), async ({ method }) => {
      sent.push(method)
      if (method === 'Emulation.setUserAgentOverride') throw new Error('Invalid UA')
    })
    expect(sent).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setEmulatedMedia'
    ])
    expect(results).toEqual([
      { capability: 'viewport', ok: true },
      { capability: 'userAgent', ok: false, message: 'Invalid UA' },
      { capability: 'touch', ok: true },
      { capability: 'colorScheme', ok: true }
    ])
  })

  it('sends every command before waiting on any answer', async () => {
    const sent: string[] = []
    const answers: Array<() => void> = []
    const applying = applyEmulation(
      emulationFor(phone, CHROME, MAC),
      ({ method }) =>
        new Promise<void>((resolve) => {
          sent.push(method)
          answers.push(resolve)
        })
    )
    expect(sent).toHaveLength(4)
    for (const answer of answers.reverse()) answer()
    expect((await applying).map((result) => result.capability)).toEqual([
      'viewport',
      'userAgent',
      'touch',
      'colorScheme'
    ])
  })

  it('treats a send that throws synchronously, or rejects with a non-error, as a rejection', async () => {
    const results = await applyEmulation(emulationFor(phone, CHROME, MAC), ({ method }) => {
      if (method === 'Emulation.setDeviceMetricsOverride') throw new Error('detached')
      if (method === 'Emulation.setEmulatedMedia') return Promise.reject('nope')
      return Promise.resolve()
    })
    expect(results.filter((result) => !result.ok)).toEqual([
      { capability: 'viewport', ok: false, message: 'detached' },
      { capability: 'colorScheme', ok: false, message: 'nope' }
    ])
  })
})
