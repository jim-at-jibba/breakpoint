import { describe, expect, it } from 'vitest'
import {
  compareGeometry,
  foldPaneStatus,
  initialPaneStatus,
  PANE_PREFERENCE,
  paneIdFromPreferences,
  paneWebPreferences,
  reconcilePaneStatuses
} from './panes'

describe('compareGeometry', () => {
  it('passes a pane drawn at its declared size times the zoom', () => {
    expect(compareGeometry({ width: 195, height: 422 }, { width: 195, height: 422 })).toEqual({
      ok: true
    })
  })

  it('forgives sub-pixel rounding from a fractional zoom', () => {
    expect(
      compareGeometry({ width: 167.7, height: 362.92 }, { width: 167.5, height: 363.4 })
    ).toEqual({ ok: true })
  })

  it('fails the Phase 0 collapse: full width, 150px tall', () => {
    const result = compareGeometry({ width: 390, height: 844 }, { width: 390, height: 150 })
    expect(result).toEqual({
      ok: false,
      message: 'drawn 390×150, declared 390×844 at this zoom'
    })
  })

  it('fails a pane that is too wide as well as one that is too short', () => {
    expect(compareGeometry({ width: 390, height: 844 }, { width: 392, height: 844 }).ok).toBe(false)
  })
})

describe('a pane status', () => {
  const mismatch = compareGeometry({ width: 390, height: 844 }, { width: 390, height: 150 })

  it('starts waiting for its attachment, unchecked, and not degraded', () => {
    expect(initialPaneStatus()).toEqual({
      attachment: 'pending',
      geometry: 'unchecked',
      degraded: []
    })
  })

  it('is degraded with the reason when its attachment fails, and still has geometry of its own', () => {
    const failed = foldPaneStatus(initialPaneStatus(), {
      type: 'attachFailed',
      message: 'Debugger is already attached to the target'
    })
    expect(failed).toEqual({
      attachment: 'failed',
      geometry: 'unchecked',
      degraded: [{ cause: 'attachment', message: 'Debugger is already attached to the target' }]
    })

    const checked = foldPaneStatus(failed, { type: 'geometryChecked', result: { ok: true } })
    expect(checked.geometry).toBe('ok')
    expect(checked.degraded).toEqual(failed.degraded)
  })

  it('stops being degraded by its attachment once a retry attaches, but keeps a geometry mismatch', () => {
    let status = foldPaneStatus(initialPaneStatus(), { type: 'attachFailed', message: 'refused' })
    status = foldPaneStatus(status, { type: 'geometryChecked', result: mismatch })
    status = foldPaneStatus(status, { type: 'attached' })

    expect(status.attachment).toBe('attached')
    expect(status.degraded).toEqual([
      { cause: 'geometry', message: 'drawn 390×150, declared 390×844 at this zoom' }
    ])
  })

  it('reports each cause once, however often it is observed', () => {
    let status = foldPaneStatus(initialPaneStatus(), { type: 'geometryChecked', result: mismatch })
    status = foldPaneStatus(status, {
      type: 'geometryChecked',
      result: { ok: false, message: 'drawn 390×100, declared 390×844 at this zoom' }
    })
    expect(status.degraded).toEqual([
      { cause: 'geometry', message: 'drawn 390×100, declared 390×844 at this zoom' }
    ])
  })

  it('clears a geometry mismatch when a later check passes', () => {
    let status = foldPaneStatus(initialPaneStatus(), { type: 'geometryChecked', result: mismatch })
    status = foldPaneStatus(status, { type: 'geometryChecked', result: { ok: true } })
    expect(status).toEqual({ attachment: 'pending', geometry: 'ok', degraded: [] })
  })

  it('starts over when its guest is replaced, since nothing observed of the old one holds', () => {
    let status = foldPaneStatus(initialPaneStatus(), { type: 'attachFailed', message: 'refused' })
    status = foldPaneStatus(status, { type: 'geometryChecked', result: mismatch })
    expect(foldPaneStatus(status, { type: 'guestCreated' })).toEqual(initialPaneStatus())
    expect(foldPaneStatus(status, { type: 'guestDestroyed' })).toEqual(initialPaneStatus())
  })
})

describe('reconcilePaneStatuses', () => {
  it('keeps what is known about surviving panes, starts new ones, and forgets removed ones', () => {
    const attached = foldPaneStatus(initialPaneStatus(), { type: 'attached' })
    const next = reconcilePaneStatuses({ a: attached, gone: attached }, ['a', 'b'])
    expect(next).toEqual({ a: attached, b: initialPaneStatus() })
  })
})

describe('the pane a guest is for', () => {
  const id = '0b7c9f64-1d2e-4c55-9a51-6f1d0f1b8e11'

  it('travels in the webpreferences attribute and is read back off the parsed preferences', () => {
    expect(paneWebPreferences(id)).toBe(`${PANE_PREFERENCE}=${id}`)
    expect(paneIdFromPreferences({ sandbox: true, [PANE_PREFERENCE]: id })).toBe(id)
  })

  it('is absent from a guest nobody asked for', () => {
    expect(paneIdFromPreferences({ sandbox: true })).toBeNull()
    expect(paneIdFromPreferences({ [PANE_PREFERENCE]: true })).toBeNull()
  })

  it('refuses an id the attribute syntax could not carry intact', () => {
    expect(() => paneWebPreferences('a,sandbox=no')).toThrow()
    expect(() => paneWebPreferences('a=b')).toThrow()
  })
})
