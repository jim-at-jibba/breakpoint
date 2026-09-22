import { EMULATION_CAPABILITIES, type EmulationCapability, type EmulationResult } from './emulation'

/**
 * What the app knows about a pane while it runs, as opposed to what the project stores
 * about it. A `Pane` is declared; a `PaneStatus` is observed.
 *
 * Pure, and imported by both processes: the main process keeps the statuses, the
 * renderer projects them, and both fold changes through the same functions here so the
 * two can never disagree about what a pane's status is.
 */

export interface Size {
  width: number
  height: number
}

export type GeometryResult = { ok: true } | { ok: false; message: string }

/**
 * What a pane may be declared as, in CSS pixels. Whole numbers because a viewport is
 * counted in them, and bounded because a pane is a `<webview>` the window has to draw:
 * a typo with an extra digit should be refused rather than rasterised.
 */
export const PANE_DIMENSION_RANGE = { min: 1, max: 10_000 } as const

export function isPaneDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PANE_DIMENSION_RANGE.min &&
    value <= PANE_DIMENSION_RANGE.max
  )
}

/** Landscape from portrait and back, without the developer doing the arithmetic. */
export function rotateSize({ width, height }: Size): Size {
  return { width: height, height: width }
}

/**
 * Screen pixels a pane may be off by before it counts as the wrong size. A fractional
 * zoom lands element edges on sub-pixel positions, and that is rounding, not a bug. The
 * Phase 0 collapse was off by hundreds.
 */
export const GEOMETRY_TOLERANCE_PX = 1

/**
 * The host-side geometry check ([ADR-0004]): the pane element's own measured size
 * against its declared size times the canvas zoom, both in screen pixels. It never asks
 * emulation anything, which is what lets it catch a pane every CDP instrument would
 * call healthy.
 */
export function compareGeometry(expected: Size, measured: Size): GeometryResult {
  const off =
    Math.abs(expected.width - measured.width) > GEOMETRY_TOLERANCE_PX ||
    Math.abs(expected.height - measured.height) > GEOMETRY_TOLERANCE_PX
  if (!off) return { ok: true }
  return {
    ok: false,
    message: `drawn ${formatSize(measured)}, declared ${formatSize(expected)} at this zoom`
  }
}

function formatSize({ width, height }: Size): string {
  return `${formatPx(width)}×${formatPx(height)}`
}

function formatPx(value: number): string {
  return String(Math.round(value * 10) / 10)
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/** Whether the app has its debugging connection to the pane ([ADR-0001]). */
export type AttachmentState = 'pending' | 'attached' | 'failed'

/** The last host-side geometry check, or `unchecked` until the pane has been measured. */
export type GeometryState = 'unchecked' | 'ok' | 'mismatch'

/**
 * Whether the pane's page has finished loading where the pane was last sent. `pending`
 * from the moment a load starts, which a navigation is: what a pane finished loading
 * before it was pointed somewhere else is not where it is now.
 */
export type LoadState = 'pending' | 'loaded' | 'failed'

/**
 * Whether one emulation capability is in force on the pane's guest: `pending` until the
 * current overrides have completed, including after a setting changes. A pane whose
 * attachment failed never gets past pending.
 */
export type CapabilityState = 'pending' | 'applied' | 'failed'

export type EmulationState = Record<EmulationCapability, CapabilityState>

/**
 * One reason a rendering pane is degraded. A cause appears at most once. Each emulation
 * capability is its own cause, since each is refused on its own.
 */
export interface PaneDegradation {
  cause: 'attachment' | 'geometry' | EmulationCapability
  message: string
}

export interface PaneStatus {
  attachment: AttachmentState
  /** Where the pane's page got to on the load it is on now. */
  load: LoadState
  geometry: GeometryState
  /** What is actually emulated, as opposed to what the pane declares. */
  emulation: EmulationState
  /** Empty when the pane is healthy. A degraded pane still renders ([CONTEXT.md]). */
  degraded: PaneDegradation[]
  /**
   * Errors observed of the page in this pane since its guest was created, which is what
   * the pane header counts. Load failures are the only producer in Phase 1; the console's
   * exceptions join them in Phase 2 without the header having to learn anything new.
   */
  errors: number
}

/**
 * Whether a pane has finished loading where it was sent and is drawn at the size it
 * claims. This is what `--wait` resolves on, and deliberately nothing more: ready is
 * weaker than the `settle` Phase 3 adds network idle and log quiet to, and the two are
 * kept apart by name so a later `settle` cannot be mistaken for this.
 *
 * Emulation is not part of it. A pane whose attachment or an override was refused is
 * degraded and says so, but it is still a pane the developer is looking at, and waiting
 * for a capability that will never arrive would be waiting forever.
 */
export function isPaneReady(status: PaneStatus): boolean {
  return status.load === 'loaded' && status.geometry === 'ok'
}

/** One reason as a person reads it, the same in the window and on a terminal. */
export function describeDegradation({ cause, message }: PaneDegradation): string {
  return `${cause}: ${message}`
}

/** What can be observed about a pane, in the order it can happen. */
export type PaneObservation =
  | { type: 'guestCreated' }
  | { type: 'attached' }
  | { type: 'attachFailed'; message: string }
  | { type: 'geometryChecked'; result: GeometryResult }
  /** A load started, which a navigation is. Whatever was loaded before is not this one. */
  | { type: 'loading' }
  /** The page in the pane finished loading. */
  | { type: 'loaded' }
  /** The page in the pane failed to load. One error, counted; the pane still renders. */
  | { type: 'loadFailed' }
  | { type: 'emulationPending'; capabilities: readonly EmulationCapability[] }
  | { type: 'emulated'; results: readonly EmulationResult[] }
  | { type: 'guestDestroyed' }

export function initialPaneStatus(): PaneStatus {
  const emulation = Object.fromEntries(
    EMULATION_CAPABILITIES.map((capability) => [capability, 'pending'])
  ) as EmulationState
  return {
    attachment: 'pending',
    load: 'pending',
    geometry: 'unchecked',
    emulation,
    degraded: [],
    errors: 0
  }
}

export function foldPaneStatus(status: PaneStatus, observation: PaneObservation): PaneStatus {
  switch (observation.type) {
    case 'guestCreated':
    case 'guestDestroyed':
      // Everything observed was observed of the old guest.
      return initialPaneStatus()
    case 'attached':
      return { ...status, attachment: 'attached', degraded: without(status, 'attachment') }
    case 'loading':
      return { ...status, load: 'pending' }
    case 'loaded':
      return { ...status, load: 'loaded' }
    case 'loadFailed':
      return { ...status, load: 'failed', errors: status.errors + 1 }
    case 'attachFailed':
      return {
        ...status,
        attachment: 'failed',
        degraded: withCause(status, { cause: 'attachment', message: observation.message })
      }
    case 'geometryChecked': {
      const { result } = observation
      if (result.ok) return { ...status, geometry: 'ok', degraded: without(status, 'geometry') }
      return {
        ...status,
        geometry: 'mismatch',
        degraded: withCause(status, { cause: 'geometry', message: result.message })
      }
    }
    case 'emulated': {
      let next = status
      for (const result of observation.results) {
        const { capability } = result
        const emulation = { ...next.emulation, [capability]: result.ok ? 'applied' : 'failed' }
        const degraded = result.ok
          ? without(next, capability)
          : withCause(next, { cause: capability, message: result.message })
        next = { ...next, emulation, degraded }
      }
      return next
    }
    case 'emulationPending': {
      const emulation = { ...status.emulation }
      for (const capability of observation.capabilities) emulation[capability] = 'pending'
      return { ...status, emulation }
    }
  }
}

function without(status: PaneStatus, cause: PaneDegradation['cause']): PaneDegradation[] {
  return status.degraded.filter((degradation) => degradation.cause !== cause)
}

function withCause(status: PaneStatus, degradation: PaneDegradation): PaneDegradation[] {
  return [...without(status, degradation.cause), degradation]
}

/**
 * Statuses for a pane set that has just changed: surviving panes keep what is known about
 * them, since their guests are still the same ones, new panes start over, and removed
 * panes are forgotten.
 */
export function reconcilePaneStatuses(
  previous: Readonly<Record<string, PaneStatus>>,
  paneIds: readonly string[]
): Record<string, PaneStatus> {
  return Object.fromEntries(
    paneIds.map((id) => [id, Object.hasOwn(previous, id) ? previous[id] : initialPaneStatus()])
  )
}

// ---------------------------------------------------------------------------------------
// Binding a guest to its pane
// ---------------------------------------------------------------------------------------

/**
 * The key a pane's `<webview>` carries its id under, in the `webpreferences` attribute.
 * Electron parses that attribute into the guest's preferences before `will-attach-webview`
 * fires, and fires `did-attach-webview` for the same guest in the same task, so the host
 * learns which pane a guest is for without the renderer or the page telling it over a
 * channel of their own. The host strips the key before the guest is created.
 */
export const PANE_PREFERENCE = 'breakpointPane'

const ATTRIBUTE_SAFE = /^[^\s,=]+$/

export function paneWebPreferences(paneId: string): string {
  // A comma or an equals sign would let an id smuggle a second preference in.
  if (!ATTRIBUTE_SAFE.test(paneId)) throw new Error(`pane id ${paneId} cannot go in an attribute`)
  return `${PANE_PREFERENCE}=${paneId}`
}

export function paneIdFromPreferences(
  preferences: Readonly<Record<string, unknown>>
): string | null {
  const value = preferences[PANE_PREFERENCE]
  return typeof value === 'string' && ATTRIBUTE_SAFE.test(value) ? value : null
}
