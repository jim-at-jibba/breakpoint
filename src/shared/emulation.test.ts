import { describe, expect, expectTypeOf, it } from 'vitest'
import { applyEmulation, emulationFor, type EmulationCommand } from './emulation'

const CHROME = '140.0.7339.41'

const phone = { width: 390, height: 844, dpr: 3, mobile: true, colorScheme: 'dark' as const }
const desktop = { width: 1440, height: 900, dpr: 1, mobile: false, colorScheme: 'light' as const }

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
    expect(command(emulationFor(phone, CHROME), 'Emulation.setDeviceMetricsOverride')).toEqual({
      capability: 'viewport',
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
    })
  })

  it('sends a mobile pane as a phone, with client hints that agree', () => {
    const { capability, params } = command(
      emulationFor(phone, CHROME),
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
    const { params } = command(emulationFor(desktop, CHROME), 'Emulation.setUserAgentOverride')!
    expect(params).toMatchObject({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      userAgentMetadata: { platform: 'macOS', mobile: false }
    })
    expect(JSON.stringify(params)).not.toMatch(/Electron|breakpoint/i)
  })

  it('emulates touch for a mobile pane', () => {
    expect(command(emulationFor(phone, CHROME), 'Emulation.setTouchEmulationEnabled')).toEqual({
      capability: 'touch',
      method: 'Emulation.setTouchEmulationEnabled',
      params: { enabled: true, maxTouchPoints: 5 }
    })
  })

  it('disables touch for a desktop pane with one touch point, since CDP rejects zero even when disabling', () => {
    expect(
      command(emulationFor(desktop, CHROME), 'Emulation.setTouchEmulationEnabled')?.params
    ).toEqual({ enabled: false, maxTouchPoints: 1 })
  })

  it('forces the pane’s own colour scheme', () => {
    expect(command(emulationFor(phone, CHROME), 'Emulation.setEmulatedMedia')).toEqual({
      capability: 'colorScheme',
      method: 'Emulation.setEmulatedMedia',
      params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }
    })
    expect(command(emulationFor(desktop, CHROME), 'Emulation.setEmulatedMedia')?.params).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })
  })

  it('clears the colour scheme override for a system pane', () => {
    expect(
      command(
        emulationFor({ ...phone, colorScheme: 'system' }, CHROME),
        'Emulation.setEmulatedMedia'
      )?.params
    ).toEqual({ features: [{ name: 'prefers-color-scheme', value: '' }] })
  })

  it('covers every capability once', () => {
    expect(emulationFor(phone, CHROME).map((entry) => entry.capability)).toEqual([
      'viewport',
      'userAgent',
      'touch',
      'colorScheme'
    ])
  })
})

describe('applying the overrides', () => {
  it('reports every capability applied when CDP accepts them all', async () => {
    const sent: string[] = []
    const results = await applyEmulation(emulationFor(phone, CHROME), async ({ method }) => {
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
    const results = await applyEmulation(emulationFor(desktop, CHROME), async ({ method }) => {
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
      emulationFor(phone, CHROME),
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
    const results = await applyEmulation(emulationFor(phone, CHROME), ({ method }) => {
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
