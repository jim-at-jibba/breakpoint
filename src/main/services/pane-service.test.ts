import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulationChanges, EmulationResult } from '../../shared/emulation'
import { EventLog } from '../../shared/event-log'
import { initialPaneStatus } from '../../shared/panes'
import { createProject, type Pane, type Project } from '../../shared/project'
import { applyPatch, type RevisionedPatch } from '../../shared/state'
import type { PaneListing } from '../../shared/routes'
import { StateFeed } from '../state-feed'
import { PaneService } from './pane-service'
import { PresetService } from './preset-service'
import { PresetStore } from './preset-store'
import { ProjectService } from './project-service'
import { ProjectStore } from './project-store'

let root: string
let shop: string
let store: ProjectStore
let log: EventLog
let patches: RevisionedPatch[]
let panes: PaneService
let projects: ProjectService
let presetStore: PresetStore
let presetService: PresetService

/** A listing back as the pane it describes, so it can be compared with a stored one. */
function paneOf(listing: PaneListing): Pane {
  const pane: Record<string, unknown> = { ...listing }
  delete pane.status
  return pane as unknown as Pane
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-pane-test-')))
  shop = join(root, 'shop')
  await mkdir(shop)
  store = new ProjectStore(join(root, 'projects'))
  presetStore = new PresetStore(join(root, 'presets.json'))
  presetService = new PresetService(presetStore)
  const feed = new StateFeed()
  patches = []
  feed.subscribe((patch) => {
    patches.push(patch)
  })
  log = new EventLog()
  panes = new PaneService(feed, log, {
    updatePane: (pane, changes) => projects.updatePane(pane, changes),
    addPane: (creation) => projects.addPane(creation),
    removePane: (pane) => projects.removePane(pane),
    rotatePane: (pane) => projects.rotatePane(pane)
  })
  projects = new ProjectService(store, feed, log, panes, presetService, {
    list: () => ({ trusted: [], waiting: [] })
  })
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

describe('adding a pane', () => {
  it('resolves the preset into the pane’s own values, appends it and keeps it', async () => {
    const before = await openShop()
    const { cursor } = projects.snapshot()

    const { pane, index } = await panes.add({ preset: 'laptop' })

    expect(index).toBe(before.length)
    expect(pane).toMatchObject({
      name: 'Laptop',
      width: 1280,
      height: 800,
      dpr: 2,
      mobile: false,
      touch: false,
      userAgent: null,
      colorScheme: 'system',
      preset: 'laptop',
      session: 'default'
    })
    expect(pane.status).toEqual(initialPaneStatus())
    expect(projects.snapshot().project?.panes.map((candidate) => candidate.id)).toEqual([
      ...before.map((candidate) => candidate.id),
      pane.id
    ])

    const reopened = await projects.open(shop)
    expect(reopened.project?.panes.at(-1)).toEqual(paneOf(pane))
    expect(log.read({ since: cursor }).entries).toEqual([
      expect.objectContaining({
        pane: pane.id,
        type: 'pane.added',
        width: 1280,
        height: 800,
        preset: 'laptop'
      })
    ])
  })

  it('announces the pane so the renderer projects the same set', async () => {
    const before = projects.snapshot()
    await openShop()
    const opened = projects.snapshot()

    const { pane, index } = await panes.add({ preset: 'mobileS' })

    expect(patches.map(({ patch }) => patch)).toEqual([
      { type: 'pane.added', pane: paneOf(pane), index }
    ])
    const projected = patches.reduce(applyPatch, { ...opened, revision: before.revision })
    expect(projected.project).toEqual(projects.snapshot().project)
    expect(projected.panes).toEqual(projects.snapshot().panes)
  })

  it('adds a pane at a size the developer typed, belonging to no preset', async () => {
    await openShop()

    const { pane } = await panes.add({ width: 1024, height: 768 })

    expect(pane).toMatchObject({
      name: '1024×768',
      width: 1024,
      height: 768,
      dpr: 1,
      mobile: false,
      touch: false,
      preset: null
    })
  })

  /** [ADR-0011]: a preset is consulted at creation time and never again. */
  it('follows a preset edited between two adds, and leaves the pane already saved alone', async () => {
    await openShop()
    const first = await panes.add({ preset: 'laptop' })

    const { presets } = await presetService.list()
    await presetStore.save(
      presets.map((preset) => (preset.id === 'laptop' ? { ...preset, width: 1366 } : preset))
    )
    const second = await panes.add({ preset: 'laptop' })

    expect(second.pane.width).toBe(1366)
    expect(panes.paneFor(first.pane.id)?.width).toBe(1280)
    const reopened = await projects.open(shop)
    expect(reopened.project?.panes.map((pane) => pane.width)).toEqual([390, 820, 1440, 1280, 1366])
  })

  it('refuses a preset that is not in the file, changing nothing', async () => {
    await openShop()
    const before = projects.snapshot()

    await expect(panes.add({ preset: 'watch' })).rejects.toMatchObject({
      code: 'PRESET_NOT_FOUND'
    })
    expect(projects.snapshot()).toEqual(before)
    expect(patches).toEqual([])
  })

  it('refuses to add to nothing when no project is open', async () => {
    await expect(panes.add({ preset: 'laptop' })).rejects.toMatchObject({
      code: 'PANE_NOT_FOUND'
    })
  })

  it('finishes an add before an open requested after it, so the pane stays with its project', async () => {
    await openShop()
    const other = join(root, 'other')
    await mkdir(other)

    const adding = panes.add({ width: 1024, height: 768 })
    const opening = projects.open(other)
    const [{ pane }, opened] = await Promise.all([adding, opening])

    expect(opened.project?.repoPath).toBe(other)
    expect(opened.project?.panes.some((candidate) => candidate.id === pane.id)).toBe(false)
    expect((await projects.open(shop)).project?.panes.at(-1)?.id).toBe(pane.id)
  })
})

describe('removing a pane', () => {
  it('leaves the rest untouched, forgets what was observed of it, and survives a reopen', async () => {
    const [mobile, tablet, desktop] = await openShop()
    panes.emulated(tablet.id, [{ capability: 'viewport', ok: false, message: 'refused' }])
    const { cursor } = projects.snapshot()
    patches = []

    const removed = await panes.remove(mobile.id)

    expect(removed.pane).toEqual(mobile)
    expect(projects.snapshot().project?.panes).toEqual([tablet, desktop])
    expect(Object.keys(projects.snapshot().panes)).toEqual([tablet.id, desktop.id])
    expect(panes.statuses()[tablet.id].degraded).toEqual([
      { cause: 'viewport', message: 'refused' }
    ])
    expect(patches.map(({ patch }) => patch)).toEqual([{ type: 'pane.removed', pane: mobile.id }])
    expect(log.read({ since: cursor }).entries).toEqual([
      expect.objectContaining({ pane: mobile.id, type: 'pane.removed' })
    ])

    const reopened = await projects.open(shop)
    expect(reopened.project?.panes).toEqual([tablet, desktop])
  })

  it('lets the last pane go, which is a project with an empty canvas', async () => {
    const opened = await openShop()
    for (const pane of opened) await panes.remove(pane.id)

    expect(projects.snapshot().project?.panes).toEqual([])
    expect((await projects.open(shop)).project?.panes).toEqual([])
  })

  it('refuses a pane the open project does not have, changing nothing', async () => {
    await openShop()
    const before = projects.snapshot()

    await expect(panes.remove('ghost')).rejects.toMatchObject({ code: 'PANE_NOT_FOUND' })
    expect(projects.snapshot()).toEqual(before)
    expect(patches).toEqual([])
  })
})

describe('resizing and rotating a pane', () => {
  it('takes exact dimensions, keeps them, and marks the viewport override pending', async () => {
    const [mobile] = await openShop()
    panes.emulated(mobile.id, [
      { capability: 'viewport', ok: true },
      { capability: 'colorScheme', ok: true }
    ])
    const { cursor } = projects.snapshot()

    const { pane } = await panes.resize({ pane: mobile.id, width: 412, height: 915 })

    expect(pane).toMatchObject({ width: 412, height: 915, preset: 'mobile' })
    expect(pane.status.emulation).toMatchObject({ viewport: 'pending', colorScheme: 'applied' })
    expect((await projects.open(shop)).project?.panes[0]).toMatchObject({
      width: 412,
      height: 915
    })
    expect(log.read({ since: cursor }).entries).toEqual([
      expect.objectContaining({ pane: mobile.id, type: 'pane.resized', width: 412, height: 915 })
    ])
  })

  it('takes one dimension on its own, leaving the other as it is', async () => {
    const [mobile] = await openShop()

    const { pane } = await panes.resize({ pane: mobile.id, width: 412 })

    expect(pane).toMatchObject({ width: 412, height: mobile.height })
  })

  it('swaps the dimensions when rotated, and twice is where it started', async () => {
    const [mobile] = await openShop()

    const landscape = await panes.rotate(mobile.id)
    expect(landscape.pane).toMatchObject({ width: 844, height: 390 })

    const portrait = await panes.rotate(mobile.id)
    expect(portrait.pane).toMatchObject({ width: mobile.width, height: mobile.height })
  })

  it('rotates the pane as it is when its turn comes, not as it was when asked', async () => {
    const [mobile] = await openShop()

    const [, rotated] = await Promise.all([
      panes.resize({ pane: mobile.id, width: 300, height: 600 }),
      panes.rotate(mobile.id)
    ])

    expect(rotated.pane).toMatchObject({ width: 600, height: 300 })
  })

  it('says and does nothing when the dimensions are the ones the pane already has', async () => {
    const [mobile] = await openShop()
    const { cursor } = projects.snapshot()

    const { pane } = await panes.resize({
      pane: mobile.id,
      width: mobile.width,
      height: mobile.height
    })

    expect(paneOf(pane)).toEqual(mobile)
    expect(patches).toEqual([])
    expect(log.read({ since: cursor }).entries).toEqual([])
  })

  it('refuses a pane the open project does not have', async () => {
    await openShop()
    await expect(panes.resize({ pane: 'ghost', width: 300, height: 600 })).rejects.toMatchObject({
      code: 'PANE_NOT_FOUND'
    })
    await expect(panes.rotate('ghost')).rejects.toMatchObject({ code: 'PANE_NOT_FOUND' })
    expect(patches).toEqual([])
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
    { touch: false },
    { dpr: 2, mobile: false, touch: false, colorScheme: 'light' }
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
        touch: changes.touch !== undefined ? 'pending' : 'applied',
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

describe('counting a pane’s errors', () => {
  it('counts a load that failed, announces it, and keeps the pane out of degraded', async () => {
    const [mobile] = await openShop()

    panes.loadFailed({
      pane: mobile.id,
      url: 'http://localhost:3000/',
      code: -102,
      message: 'ERR_CONNECTION_REFUSED'
    })

    expect(panes.statuses()[mobile.id].errors).toBe(1)
    // A dev server that is down is not an instrument that failed.
    expect(panes.statuses()[mobile.id].degraded).toEqual([])
    expect(patches.map(({ patch }) => patch.type)).toEqual(['pane.status'])
  })

  it('starts the count again for a new guest, because the errors were the old one’s', async () => {
    const [mobile] = await openShop()

    panes.loadFailed({ pane: mobile.id, url: 'http://x/', code: -102, message: 'refused' })
    panes.loadFailed({ pane: mobile.id, url: 'http://x/', code: -102, message: 'refused' })
    expect(panes.statuses()[mobile.id].errors).toBe(2)

    panes.guestCreated(mobile.id, 'http://x/')
    expect(panes.statuses()[mobile.id].errors).toBe(0)
  })
})
