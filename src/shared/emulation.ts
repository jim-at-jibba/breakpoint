import type { Pane } from './project'

/**
 * Emulation: the overrides that make a pane behave as it describes rather than as the
 * element it is drawn in (PRD 8.5). All of it is CDP, one command per capability, so a
 * capability CDP refuses is refused on its own.
 *
 * Pure: the commands are data, and the runner takes whatever sends them. The pane host
 * hands it the guest's attachment; tests hand it a function.
 */

/** What emulation can independently succeed or fail at. */
export const EMULATION_CAPABILITIES = ['viewport', 'userAgent', 'touch', 'colorScheme'] as const

export type EmulationCapability = (typeof EMULATION_CAPABILITIES)[number]

/** The part of a pane emulation reads. Everything else about a pane is the canvas's business. */
export type PaneEmulation = Pick<Pane, 'width' | 'height' | 'dpr' | 'mobile' | 'colorScheme'>

/**
 * What `panes.setEmulation` may change. Size is not here: resizing a pane is a change to
 * the canvas as well as to emulation, and belongs with the rest of pane management.
 */
export type EmulationChanges = Partial<Pick<Pane, 'dpr' | 'mobile' | 'colorScheme'>>

export interface EmulationCommand {
  capability: EmulationCapability
  method: string
  params: Record<string, unknown>
}

export type EmulationResult =
  | { capability: EmulationCapability; ok: true }
  | { capability: EmulationCapability; ok: false; message: string }

/**
 * The overrides for one pane. `chromeVersion` is the engine's own, so the user agent and
 * its client hints claim the Chromium that is actually rendering.
 */
export function emulationFor(pane: PaneEmulation, chromeVersion: string): EmulationCommand[] {
  return [
    {
      capability: 'viewport',
      method: 'Emulation.setDeviceMetricsOverride',
      // The CSS viewport is the declared size, independent of the size the pane is drawn
      // at, which is what makes canvas zoom possible at all.
      params: {
        width: pane.width,
        height: pane.height,
        deviceScaleFactor: pane.dpr,
        mobile: pane.mobile
      }
    },
    {
      capability: 'userAgent',
      method: 'Emulation.setUserAgentOverride',
      params: userAgentFor(pane.mobile, chromeVersion)
    },
    {
      capability: 'touch',
      method: 'Emulation.setTouchEmulationEnabled',
      params: {
        enabled: pane.mobile,
        maxTouchPoints: pane.mobile ? 5 : 1 // not 0 — CDP rejects it even when disabling (#4)
      }
    },
    {
      capability: 'colorScheme',
      method: 'Emulation.setEmulatedMedia',
      // A pane's own, and nothing to do with the app theme. `system` clears the override,
      // so the page follows Chromium's native theme — which is the OS only for as long as
      // nothing sets `nativeTheme.themeSource`. The app theme override (#18) must not use
      // it, or every `system` pane would follow the app instead: measured, it does.
      params: {
        features: [
          {
            name: 'prefers-color-scheme',
            value: pane.colorScheme === 'system' ? '' : pane.colorScheme
          }
        ]
      }
    }
  ]
}

/**
 * The reduced user agent Chrome itself sends, with client hints that tell the same story,
 * so server-side detection reading either sees the same device. A pane chooses by its
 * mobile flag until presets carry a user agent of their own (#12).
 */
function userAgentFor(mobile: boolean, chromeVersion: string): Record<string, unknown> {
  const major = chromeVersion.split('.')[0]
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Not=A?Brand', version: '24' }
  ]
  const fullVersionList = [
    { brand: 'Chromium', version: chromeVersion },
    { brand: 'Not=A?Brand', version: '24.0.0.0' }
  ]

  if (mobile) {
    return {
      userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      platform: 'Linux armv81',
      userAgentMetadata: {
        brands,
        fullVersionList,
        platform: 'Android',
        platformVersion: '10.0.0',
        architecture: '',
        model: 'K',
        mobile: true
      }
    }
  }
  return {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: 'MacIntel',
    userAgentMetadata: {
      brands,
      fullVersionList,
      platform: 'macOS',
      platformVersion: '15.0.0',
      architecture: 'arm',
      model: '',
      mobile: false
    }
  }
}

export type SendCommand = (command: EmulationCommand) => Promise<unknown>

/**
 * Sends every command, each inside its own error handling: one rejected override degrades
 * one capability rather than costing the pane the rest (#4).
 *
 * Every command is sent in the same task, in order, before any answer is awaited. A new
 * guest starts loading as soon as it attaches, and overrides still waiting behind an
 * earlier answer would miss its first request. Results come back in command order.
 */
export function applyEmulation(
  commands: readonly EmulationCommand[],
  send: SendCommand
): Promise<EmulationResult[]> {
  return Promise.all(
    commands.map(async (command): Promise<EmulationResult> => {
      try {
        await send(command)
        return { capability: command.capability, ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { capability: command.capability, ok: false, message }
      }
    })
  )
}
