import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EmulationResult } from '../../shared/emulation'
import { EventLog } from '../../shared/event-log'
import type { Pane } from '../../shared/project'
import type { RevisionedPatch } from '../../shared/state'
import { StateFeed } from '../state-feed'
import { PaneService } from './pane-service'
import { ProjectService } from './project-service'
import { ProjectStore } from './project-store'

let root: string
let shop: string
let store: ProjectStore
let log: EventLog
let patches: RevisionedPatch[]
let panes: PaneService
let projects: ProjectService

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-pane-test-')))
  shop = join(root, 'shop')
  await mkdir(shop)
  store = new ProjectStore(join(root, 'projects'))
  const feed = new StateFeed()
  patches = []
  feed.subscribe((patch) => {
    patches.push(patch)
  })
  log = new EventLog()
  panes = new PaneService(feed, log, {
    updatePane: (pane, changes) => projects.updatePane(pane, changes)
  })
  projects = new ProjectService(store, feed, log, panes)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function openShop(): Promise<Pane[]> {
  const { project } = await projects.open(shop)
  patches = []
  return project!.panes
}

describe('setting a pane’s emulation', () => {
  it('changes the pane, keeps it across a reopen, and tells the window', async () => {
    const [mobile, tablet] = await openShop()

    const { pane } = await panes.setEmulation({ pane: tablet.id, colorScheme: 'dark' })

    expect(pane).toMatchObject({ id: tablet.id, colorScheme: 'dark', width: tablet.width })
    expect(panes.paneFor(tablet.id)?.colorScheme).toBe('dark')
    expect(projects.snapshot().project?.panes[1].colorScheme).toBe('dark')
    expect(patches.map(({ patch }) => patch)).toEqual([
      { type: 'pane.changed', pane: { ...tablet, colorScheme: 'dark' } }
    ])

    const stored = await store.load(projects.snapshot().project!.repoPath)
    expect(stored.status === 'loaded' && stored.project.panes.map((p) => p.colorScheme)).toEqual([
      mobile.colorScheme,
      'dark',
      'system'
    ])
  })

  it('records the change against the pane', async () => {
    const [mobile] = await openShop()
    const { cursor } = projects.snapshot()

    await panes.setEmulation({ pane: mobile.id, dpr: 2, mobile: false })

    expect(log.read({ since: cursor }).entries).toEqual([
      expect.objectContaining({
        pane: mobile.id,
        type: 'pane.emulationChanged',
        changes: { dpr: 2, mobile: false }
      })
    ])
  })

  it('does nothing, and says nothing, when the values are the ones the pane already has', async () => {
    const [mobile] = await openShop()
    const { cursor } = projects.snapshot()

    const { pane } = await panes.setEmulation({ pane: mobile.id, colorScheme: mobile.colorScheme })

    expect(pane).toMatchObject(mobile)
    expect(patches).toEqual([])
    expect(log.read({ since: cursor }).entries).toEqual([])
  })

  it('refuses a pane the open project does not have', async () => {
    await openShop()
    const { cursor } = projects.snapshot()

    await expect(panes.setEmulation({ pane: 'ghost', colorScheme: 'dark' })).rejects.toMatchObject({
      code: 'PANE_NOT_FOUND'
    })
    await expect(
      panes.setEmulation({ pane: 'constructor', colorScheme: 'dark' })
    ).rejects.toMatchObject({ code: 'PANE_NOT_FOUND' })
    expect(patches).toEqual([])
    expect(log.read({ since: cursor }).entries).toEqual([])
  })
})

describe('reporting what emulation applied', () => {
  const applied: EmulationResult[] = [
    { capability: 'viewport', ok: true },
    { capability: 'userAgent', ok: true },
    { capability: 'touch', ok: true },
    { capability: 'colorScheme', ok: true }
  ]
  const refused: EmulationResult[] = [
    ...applied.slice(0, 3),
    { capability: 'colorScheme', ok: false, message: 'Invalid feature' }
  ]

  it('marks every capability applied without writing an entry', async () => {
    const [mobile] = await openShop()
    const { cursor } = projects.snapshot()

    panes.emulated(mobile.id, applied)

    expect(panes.statuses()[mobile.id].emulation).toEqual({
      viewport: 'applied',
      userAgent: 'applied',
      touch: 'applied',
      colorScheme: 'applied'
    })
    expect(log.read({ since: cursor }).entries).toEqual([])
  })

  it('degrades the one refused capability, records why once, and records its recovery', async () => {
    const [mobile] = await openShop()
    const { cursor } = projects.snapshot()

    panes.emulated(mobile.id, refused)
    // Reapplied on navigation and refused again: nothing new to say.
    panes.emulated(mobile.id, refused)

    expect(panes.statuses()[mobile.id].degraded).toEqual([
      { cause: 'colorScheme', message: 'Invalid feature' }
    ])
    expect(panes.statuses()[mobile.id].emulation.viewport).toBe('applied')

    panes.emulated(mobile.id, applied)

    expect(panes.statuses()[mobile.id].degraded).toEqual([])
    expect(log.read({ since: cursor }).entries).toEqual([
      expect.objectContaining({
        pane: mobile.id,
        type: 'pane.emulationFailed',
        capability: 'colorScheme',
        message: 'Invalid feature'
      }),
      expect.objectContaining({
        pane: mobile.id,
        type: 'pane.emulationRecovered',
        capability: 'colorScheme'
      })
    ])
    expect(patches.map(({ patch }) => patch.type)).toEqual(['pane.status', 'pane.status'])
  })
})
