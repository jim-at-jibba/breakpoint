import type { Pane, PaneChanges } from './project'

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
export type PaneEmulation = Pick<
  Pane,
  'width' | 'height' | 'dpr' | 'mobile' | 'touch' | 'userAgent' | 'colorScheme'
>

/**
 * What `panes.setEmulation` may change. Size is not here: resizing a pane is a change to
 * the canvas as well as to emulation, and belongs with the rest of pane management.
 */
export type EmulationChanges = Partial<Pick<Pane, 'dpr' | 'mobile' | 'touch' | 'colorScheme'>>

interface UserAgentBrand {
  brand: string
  version: string
}

interface UserAgentOverride {
  userAgent: string
  platform: string
  userAgentMetadata: {
    brands: UserAgentBrand[]
    fullVersionList: UserAgentBrand[]
    platform: string
    platformVersion: string
    architecture: string
    model: string
    mobile: boolean
  }
}

export type EmulationCommand =
  | {
      capability: 'viewport'
      method: 'Emulation.setDeviceMetricsOverride'
      params: { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
    }
  | {
      capability: 'userAgent'
      method: 'Emulation.setUserAgentOverride'
      params: UserAgentOverride
    }
  | {
      capability: 'touch'
      method: 'Emulation.setTouchEmulationEnabled'
      params: { enabled: boolean; maxTouchPoints: number }
    }
  | {
      capability: 'colorScheme'
      method: 'Emulation.setEmulatedMedia'
      params: { features: [{ name: 'prefers-color-scheme'; value: 'light' | 'dark' | '' }] }
    }

export type EmulationResult =
  | { capability: EmulationCapability; ok: true }
  | { capability: EmulationCapability; ok: false; message: string }

/**
 * The overrides for one pane. `chromeVersion` is the engine's own, so the user agent and
 * its client hints claim the Chromium that is actually rendering; `host` is the machine it
 * is rendering on, which a desktop pane reports as its own.
 */
export function emulationFor(
  pane: PaneEmulation,
  chromeVersion: string,
  host: HostIdentity
): EmulationCommand[] {
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
      params: userAgentFor({
        mobile: pane.mobile,
        chromeVersion,
        userAgent: pane.userAgent,
        host
      })
    },
    {
      capability: 'touch',
      method: 'Emulation.setTouchEmulationEnabled',
      params: {
        enabled: pane.touch,
        maxTouchPoints: pane.touch ? 5 : 1 // not 0 — CDP rejects it even when disabling (#4)
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

interface UserAgentOptions {
  mobile: boolean
  chromeVersion: string
  /** The pane's own, resolved from its preset, or `null` for Breakpoint's ([presets.ts]). */
  userAgent: string | null
  host: HostIdentity
}

/**
 * The machine Breakpoint is running on, which a desktop pane reports as its own. Read at
 * the boundary and passed in, the way [paths.ts] takes a `PathEnvironment`, so this module
 * stays pure and a test can claim to be any host.
 */
export interface HostIdentity {
  platform: NodeJS.Platform
  arch: string
}

export function currentHostIdentity(): HostIdentity {
  return { platform: process.platform, arch: process.arch }
}

/**
 * What a desktop pane says it is running on. Chrome's reduced user agent is frozen per
 * platform — macOS reports `Intel Mac OS X 10_15_7` on Apple silicon too, which is why the
 * architecture only ever appears in the client hints.
 */
function desktopIdentity({ platform }: HostIdentity): {
  system: string
  navigatorPlatform: string
  hintPlatform: string
  hintVersion: string
} {
  if (platform === 'win32') {
    // UA-CH reports Windows 11 as platformVersion 15.0.0; the UA string stays at NT 10.0.
    return {
      system: 'Windows NT 10.0; Win64; x64',
      navigatorPlatform: 'Win32',
      hintPlatform: 'Windows',
      hintVersion: '15.0.0'
    }
  }
  if (platform === 'darwin') {
    return {
      system: 'Macintosh; Intel Mac OS X 10_15_7',
      navigatorPlatform: 'MacIntel',
      hintPlatform: 'macOS',
      hintVersion: '15.0.0'
    }
  }
  return {
    system: 'X11; Linux x86_64',
    navigatorPlatform: 'Linux x86_64',
    hintPlatform: 'Linux',
    // Chrome sends an empty platform version on Linux rather than a kernel release.
    hintVersion: ''
  }
}

/** What UA-CH calls the architecture. Not the Node name, and never in the user agent string. */
function hintArchitecture(arch: string): string {
  return arch === 'arm64' || arch === 'arm' ? 'arm' : 'x86'
}

/**
 * The reduced user agent Chrome itself sends, with client hints that tell the same story,
 * so server-side detection reading either sees the same device. A pane whose preset gave
 * it a user agent of its own sends that instead; the client hints keep following the
 * mobile flag, because a preset carries one user agent and not a whole hint set.
 */
function userAgentFor({
  mobile,
  chromeVersion,
  userAgent,
  host
}: UserAgentOptions): UserAgentOverride {
  const major = chromeVersion.split('.')[0]
  const brands: UserAgentBrand[] = [
    { brand: 'Chromium', version: major },
    { brand: 'Not=A?Brand', version: '24' }
  ]
  const fullVersionList: UserAgentBrand[] = [
    { brand: 'Chromium', version: chromeVersion },
    { brand: 'Not=A?Brand', version: '24.0.0.0' }
  ]

  if (mobile) {
    return {
      userAgent:
        userAgent ??
        `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
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
  // A desktop pane is the machine it is running on. Reporting macOS from a Linux host
  // would make every observation of a UA-sniffing page a quiet lie, and observation is the
  // product. A preset that declares its own user agent still wins, as above.
  const identity = desktopIdentity(host)
  return {
    userAgent:
      userAgent ??
      `Mozilla/5.0 (${identity.system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: identity.navigatorPlatform,
    userAgentMetadata: {
      brands,
      fullVersionList,
      platform: identity.hintPlatform,
      platformVersion: identity.hintVersion,
      architecture: hintArchitecture(host.arch),
      model: '',
      mobile: false
    }
  }
}

export type SendCommand = (command: EmulationCommand) => Promise<unknown>

/** Which overrides a set of changed declarations puts back in doubt, in command order. */
export function affectedCapabilities(changes: PaneChanges): EmulationCapability[] {
  const capabilities: EmulationCapability[] = []
  const viewport =
    changes.width !== undefined ||
    changes.height !== undefined ||
    changes.dpr !== undefined ||
    changes.mobile !== undefined
  if (viewport) capabilities.push('viewport')
  // The mobile flag reaches the client hints, but not touch: a pane carries its own.
  if (changes.mobile !== undefined) capabilities.push('userAgent')
  if (changes.touch !== undefined) capabilities.push('touch')
  if (changes.colorScheme !== undefined) capabilities.push('colorScheme')
  return capabilities
}

/**
 * Sends every command, each inside its own error handling: one rejected override degrades
 * one capability rather than costing the pane the rest (#4).
 *
 * Every command is sent in the same task, before any answer is awaited. One slow answer
 * cannot delay sending another override. Results come back in command order.
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
