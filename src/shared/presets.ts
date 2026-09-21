import { isPaneDimension, type Size } from './panes'
import type { Pane, RefusalReason } from './project'

/**
 * Presets: named sets of viewport properties used to create a pane. Global, and
 * user-editable JSON in the app's user data directory rather than anything a project
 * owns — a developer's idea of "Mobile" does not change per repo.
 *
 * A preset is consulted once, at creation time, and the pane keeps its own resolved
 * values ([ADR-0011]). Nothing here reads a pane back; resolution only ever runs one
 * way, which is what makes "editing a preset does not reshape saved panes" a property
 * of the type rather than a rule to remember.
 *
 * Pure: the store in the main process reads and writes the file; this module decides
 * what a valid one says and what a pane resolved from it looks like.
 */

export interface Preset {
  id: string
  name: string
  width: number
  height: number
  dpr: number
  /** Whether a pane from this preset claims to be a mobile device. */
  mobile: boolean
  /** Touch emulation, on for the mobile and tablet presets (PRD 6.2 V7). */
  touch: boolean
  /**
   * The user agent a pane from this preset sends, or `null` for Breakpoint's own —
   * chosen by the mobile flag and carrying the version of the Chromium that is actually
   * rendering. The defaults are all `null`: a literal string seeded into a file would
   * claim a Chromium the app stopped shipping at the next upgrade.
   */
  userAgent: string | null
}

/** PRD 6.2: the seven the file is seeded with. Mobile and tablet set the mobile flag and touch. */
export const DEFAULT_PRESETS: readonly Preset[] = Object.freeze([
  preset('mobileS', 'Mobile S', 360, 800, 3, true),
  preset('mobile', 'Mobile', 390, 844, 3, true),
  preset('mobileL', 'Mobile L', 430, 932, 3, true),
  preset('tablet', 'Tablet', 820, 1180, 2, true),
  preset('laptop', 'Laptop', 1280, 800, 2, false),
  preset('desktop', 'Desktop', 1440, 900, 1, false),
  preset('desktopL', 'Desktop L', 1920, 1080, 1, false)
])

function preset(
  id: string,
  name: string,
  width: number,
  height: number,
  dpr: number,
  handheld: boolean
): Preset {
  return { id, name, width, height, dpr, mobile: handheld, touch: handheld, userAgent: null }
}

/** PRD 6.2 V1: the pane set a project is useful with before anything is configured. */
export const DEFAULT_PANE_PRESETS: readonly string[] = Object.freeze([
  'mobile',
  'tablet',
  'desktop'
])

/**
 * A pane as a preset describes it, before the project gives it an identity and a session.
 * Everything a pane declares about how it renders is here, which is what makes the
 * resolution total: no field of a pane is left to be filled in from the preset later.
 */
export type PaneDraft = Omit<Pane, 'id' | 'session'>

export function presetById(presets: readonly Preset[], id: string): Preset | undefined {
  return presets.find((preset) => preset.id === id)
}

/**
 * The one resolution from a preset to a pane's own values ([ADR-0011]). The preset id is
 * carried through for display; nothing reads it back to find a size again.
 */
export function paneFromPreset(preset: Preset): PaneDraft {
  return {
    name: preset.name,
    width: preset.width,
    height: preset.height,
    dpr: preset.dpr,
    mobile: preset.mobile,
    touch: preset.touch,
    userAgent: preset.userAgent,
    colorScheme: 'system',
    preset: preset.id
  }
}

/** A pane at a size the developer typed, belonging to no preset. */
export function paneFromSize({ width, height }: Size, name?: string): PaneDraft {
  return {
    name: name ?? `${width}×${height}`,
    width,
    height,
    dpr: 1,
    mobile: false,
    touch: false,
    userAgent: null,
    colorScheme: 'system',
    preset: null
  }
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

/** Bumped whenever the stored shape changes. A newer file refuses to load, as projects do. */
export const PRESET_FILE_VERSION = 1

export interface PresetFile {
  version: number
  presets: Preset[]
}

export type ReadPresetResult =
  { ok: true; presets: Preset[] } | { ok: false; reason: RefusalReason; message: string }

export function writePresetFile(presets: readonly Preset[]): PresetFile {
  return { version: PRESET_FILE_VERSION, presets: [...presets] }
}

export function readPresetFile(raw: unknown, version = PRESET_FILE_VERSION): ReadPresetResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return corrupt('the file is not a JSON object')
  }
  const file = raw as Record<string, unknown>
  if (!Number.isInteger(file.version)) return corrupt('the file has no integer version')
  if ((file.version as number) > version) {
    return {
      ok: false,
      reason: 'newer',
      message: `written by a newer Breakpoint (file version ${String(file.version)}, this build reads ${version})`
    }
  }
  if (!Array.isArray(file.presets)) return corrupt('the file holds no preset list')

  const presets: Preset[] = []
  const seen = new Set<string>()
  for (const entry of file.presets) {
    const preset = parsePreset(entry)
    if (!preset) return corrupt('one of the presets is not a preset')
    // Two presets under one id means `preset: "mobile"` on a pane names two things.
    if (seen.has(preset.id)) return corrupt(`two presets share the id ${preset.id}`)
    seen.add(preset.id)
    presets.push(preset)
  }
  return { ok: true, presets }
}

function corrupt(message: string): ReadPresetResult {
  return { ok: false, reason: 'corrupt', message }
}

/** Every field checked, and only the known fields copied out, so the result is exactly a `Preset`. */
function parsePreset(value: unknown): Preset | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (typeof raw.name !== 'string' || raw.name.length === 0) return undefined
  if (!isPaneDimension(raw.width) || !isPaneDimension(raw.height)) return undefined
  if (typeof raw.dpr !== 'number' || !Number.isFinite(raw.dpr) || raw.dpr <= 0) return undefined
  if (typeof raw.mobile !== 'boolean' || typeof raw.touch !== 'boolean') return undefined
  if (raw.userAgent !== null && typeof raw.userAgent !== 'string') return undefined
  return {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    dpr: raw.dpr,
    mobile: raw.mobile,
    touch: raw.touch,
    userAgent: raw.userAgent
  }
}
