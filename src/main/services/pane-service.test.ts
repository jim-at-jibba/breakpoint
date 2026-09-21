import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulationChanges, EmulationResult } from '../../shared/emulation'
import { EventLog } from '../../shared/event-log'
import { createProject, type Pane, type Project } from '../../shared/project'
import { applyPatch, type RevisionedPatch } from '../../shared/state'
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
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

interface SaveGate {
  started: Promise<void>
  release(): void
}

function holdNextSave(): SaveGate {
  let release: () => void = (): void => {
    throw new Error('save has not been held')
  }
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const save = store.save.bind(store)
  const started = new Promise<void>((resolve) => {
    vi.spyOn(store, 'save').mockImplementationOnce(async (project: Project): Promise<void> => {
      resolve()
      await held
      await save(project)
    })
  })
  return { started, release }
}

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

  it('leaves disk, state and announcements untouched when saving fails, then accepts another update', async () => {
    const [mobile] = await openShop()
    const before = projects.snapshot()
    const stored = await store.load(shop)
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'))

    await expect(panes.setEmulation({ pane: mobile.id, dpr: 2 })).rejects.toThrow('disk full')

    expect(projects.snapshot()).toEqual(before)
    expect(await store.load(shop)).toEqual(stored)
    expect(patches).toEqual([])
    expect(log.read({ since: before.cursor }).entries).toEqual([])

    await panes.setEmulation({ pane: mobile.id, colorScheme: 'dark' })
    expect(panes.paneFor(mobile.id)).toEqual({ ...mobile, colorScheme: 'dark' })
    const reopened = await projects.open(shop)
    expect(reopened.project?.panes[0]).toEqual({ ...mobile, colorScheme: 'dark' })
  })

  it('keeps the previous snapshot while saving and merges concurrent settings in arrival order', async () => {
    const [mobile] = await openShop()
    const before = projects.snapshot()
    const stored = await store.load(shop)
    const gate = holdNextSave()
    const first = panes.setEmulation({ pane: mobile.id, dpr: 2 })
    const second = panes.setEmulation({ pane: mobile.id, colorScheme: 'dark' })
    await gate.started

    expect(projects.snapshot()).toEqual(before)
    expect(await store.load(shop)).toEqual(stored)
    expect(patches).toEqual([])
    expect(store.save).toHaveBeenCalledTimes(1)

    gate.release()
    const [one, two] = await Promise.all([first, second])
    expect(one.pane).toMatchObject({ dpr: 2, colorScheme: 'system' })
    expect(two.pane).toMatchObject({ dpr: 2, colorScheme: 'dark' })
    expect(patches.map(({ patch }) => patch)).toEqual([
      { type: 'pane.changed', pane: { ...mobile, dpr: 2 } },
      { type: 'pane.changed', pane: { ...mobile, dpr: 2, colorScheme: 'dark' } }
    ])
    expect((await projects.open(shop)).project?.panes[0]).toEqual({
      ...mobile,
      dpr: 2,
      colorScheme: 'dark'
    })
  })

  it('saves an earlier update before switching projects and rejects a later update for the old pane', async () => {
    const [mobile] = await openShop()
    const other = join(root, 'other')
    await mkdir(other)
    const gate = holdNextSave()
    const changed = panes.setEmulation({ pane: mobile.id, dpr: 2 })
    const opened = projects.open(other)
    const obsolete = expect(
      panes.setEmulation({ pane: mobile.id, colorScheme: 'dark' })
    ).rejects.toMatchObject({ code: 'PANE_NOT_FOUND' })
    await gate.started
    expect(projects.snapshot().project?.repoPath).toBe(shop)

    gate.release()
    await changed
    const next = await opened
    await obsolete
    expect(projects.snapshot().project).toEqual(next.project)
    expect(patches.map(({ patch }) => patch.type)).toEqual(['pane.changed', 'project.opened'])
    expect((await projects.open(shop)).project?.panes[0]).toEqual({ ...mobile, dpr: 2 })
  })

  it('applies a setting queued behind an open to the newly opened project', async () => {
    await openShop()
    const stored = await store.load(shop)
    const other = join(root, 'other')
    await mkdir(other)
    const otherProject = createProject(other)
    await store.save(otherProject)
    const opened = projects.open(other)
    const changed = panes.setEmulation({ pane: otherProject.panes[0].id, dpr: 2 })
    await opened
    expect((await changed).pane.dpr).toBe(2)
    expect(await store.load(shop)).toEqual(stored)
    expect((await projects.open(other)).project?.panes[0].dpr).toBe(2)
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

  const settings: EmulationChanges[] = [
    { colorScheme: 'dark' },
    { dpr: 2 },
    { mobile: false },
    { dpr: 2, mobile: false, colorScheme: 'light' }
  ]

  it.each(settings)(
    'invalidates only affected capabilities for %j and keeps the renderer in sync',
    async (changes: EmulationChanges) => {
      const [mobile] = await openShop()
      panes.emulated(mobile.id, applied)
      const before = projects.snapshot()
      patches = []

      const { pane } = await panes.setEmulation({ pane: mobile.id, ...changes })
      const expected = {
        viewport: changes.dpr !== undefined || changes.mobile !== undefined ? 'pending' : 'applied',
        userAgent: changes.mobile !== undefined ? 'pending' : 'applied',
        touch: changes.mobile !== undefined ? 'pending' : 'applied',
        colorScheme: changes.colorScheme !== undefined ? 'pending' : 'applied'
      }
      expect(pane.status.emulation).toEqual(expected)
      expect(patches.map(({ patch }) => patch.type)).toEqual(['pane.status', 'pane.changed'])
      const projected = patches.reduce(applyPatch, before)
      expect(projected.panes).toEqual(projects.snapshot().panes)
      expect(projected.project).toEqual(projects.snapshot().project)

      panes.emulated(mobile.id, applied)
      expect(patches.at(-1)?.patch).toMatchObject({
        type: 'pane.status',
        pane: mobile.id,
        status: {
          emulation: {
            viewport: 'applied',
            userAgent: 'applied',
            touch: 'applied',
            colorScheme: 'applied'
          }
        }
      })
    }
  )

  it('keeps a previous failure visible while a changed setting is pending and records recovery', async () => {
    const [mobile] = await openShop()
    panes.emulated(mobile.id, refused)
    const { cursor } = projects.snapshot()

    const { pane } = await panes.setEmulation({ pane: mobile.id, colorScheme: 'light' })
    expect(pane.status.emulation.colorScheme).toBe('pending')
    expect(pane.status.degraded).toEqual([{ cause: 'colorScheme', message: 'Invalid feature' }])

    panes.emulated(mobile.id, applied)
    expect(panes.statuses()[mobile.id].degraded).toEqual([])
    expect(log.read({ since: cursor }).entries.map((entry) => entry.type)).toEqual([
      'pane.emulationChanged',
      'pane.emulationRecovered'
    ])
  })

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
