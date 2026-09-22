import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProject,
  projectFileName,
  writeProjectFile,
  type Project
} from '../../shared/project'
import { EventLog } from '../../shared/event-log'
import type { RevisionedPatch } from '../../shared/state'
import { StateFeed } from '../state-feed'
import { PaneService } from './pane-service'
import { PresetService } from './preset-service'
import { PresetStore } from './preset-store'
import { ProjectService } from './project-service'
import { ProjectStore } from './project-store'

function openedRepo({ patch }: RevisionedPatch): string | undefined {
  return patch.type === 'project.opened' ? patch.project.repoPath : undefined
}

let root: string
let shop: string
let other: string
let store: ProjectStore
let service: ProjectService
let panes: PaneService
let log: EventLog
let patches: RevisionedPatch[]

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-project-test-')))
  shop = join(root, 'shop')
  other = join(root, 'other')
  await Promise.all([mkdir(shop), mkdir(other)])
  store = new ProjectStore(join(root, 'projects'))
  const feed = new StateFeed()
  patches = []
  feed.subscribe((patch: RevisionedPatch): void => {
    patches.push(patch)
  })
  log = new EventLog()
  const presets = new PresetService(new PresetStore(join(root, 'presets.json')))
  panes = new PaneService(feed, log, {
    updatePane: (pane, changes) => service.updatePane(pane, changes),
    addPane: (creation) => service.addPane(creation),
    removePane: (pane) => service.removePane(pane),
    rotatePane: (pane) => service.rotatePane(pane)
  })
  // Certificate trust is not this service's; the snapshot simply carries it.
  service = new ProjectService(store, feed, log, panes, presets, {
    list: () => ({ trusted: [], waiting: [] })
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('an open that fails', () => {
  it('writes an untagged entry a reader can find from its cursor, and still throws', async () => {
    const before = service.snapshot()

    await expect(service.open(join(root, 'nowhere'))).rejects.toMatchObject({
      code: 'INVALID_PARAMS'
    })

    const { entries } = log.read({ since: before.cursor })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      cursor: 1,
      pane: null,
      type: 'project.openFailed',
      path: join(root, 'nowhere'),
      code: 'INVALID_PARAMS'
    })
    expect(service.snapshot().cursor).toBe(1)
  })

  it('records the same code the caller was refused with', async () => {
    await mkdir(join(root, 'projects'), { recursive: true })
    await writeFile(store.fileFor(shop), JSON.stringify({ version: 99, project: {} }))

    await expect(service.open(shop)).rejects.toMatchObject({ code: 'PROJECT_UNREADABLE' })

    const [entry] = log.read().entries
    expect(entry).toMatchObject({ code: 'PROJECT_UNREADABLE', pane: null })
    expect(entry.type === 'project.openFailed' && entry.message).toContain('file version 99')
  })

  it('leaves the log alone when an open succeeds', async () => {
    await service.open(shop)
    expect(log.read().entries).toEqual([])
    expect(service.snapshot().cursor).toBe(0)
  })
})

describe('async project opens', () => {
  it('refuses a valid file with the wrong repo identity without changing disk or current state', async () => {
    const before = await service.open(shop)
    const written = JSON.stringify(writeProjectFile(createProject(shop)))
    await writeFile(store.fileFor(other), written)

    await expect(service.open(other)).rejects.toMatchObject({
      code: 'PROJECT_UNREADABLE',
      details: { reason: 'corrupt', file: store.fileFor(other) }
    })
    expect(await readFile(store.fileFor(other), 'utf8')).toBe(written)
    // The open is untouched; only the log moved, because the refusal is an observation.
    expect(service.snapshot()).toEqual({ ...before, cursor: 1 })
    expect(patches).toHaveLength(1)
  })

  it('keeps state readable during a slow save and publishes concurrent opens in arrival order', async () => {
    let finishSave: () => void = (): void => {
      throw new Error('save has not started')
    }
    const save = store.save.bind(store)
    const started = new Promise<void>((resolve) => {
      vi.spyOn(store, 'save').mockImplementationOnce(async (project: Project): Promise<void> => {
        await new Promise<void>((finish) => {
          finishSave = finish
          resolve()
        })
        await save(project)
      })
    })

    const first = service.open(shop)
    const second = service.open(other)
    await started
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(service.snapshot()).toEqual({
      revision: 0,
      cursor: 0,
      project: null,
      panes: {},
      certificates: { trusted: [], waiting: [] }
    })
    expect(patches).toEqual([])
    expect(store.save).toHaveBeenCalledTimes(1)

    finishSave()
    const [openedShop, openedOther] = await Promise.all([first, second])
    expect(openedShop.revision).toBe(1)
    expect(openedOther.revision).toBe(2)
    expect(patches.map((patch: RevisionedPatch) => openedRepo(patch))).toEqual([shop, other])
    expect(service.snapshot()).toEqual(openedOther)
    expect(await store.load(shop)).toEqual({ status: 'loaded', project: openedShop.project })
    expect(await store.load(other)).toEqual({ status: 'loaded', project: openedOther.project })
  })

  it('does not publish a failed save and allows the next queued open to succeed', async () => {
    const before = await service.open(shop)
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'))

    const failed = service.open(other)
    const reopened = service.open(shop)
    await expect(failed).rejects.toThrow('disk full')
    expect(service.snapshot()).toEqual({ ...before, cursor: 1 })
    expect(await store.load(other)).toEqual({ status: 'missing' })
    await expect(reopened).resolves.toEqual({
      revision: 2,
      cursor: 1,
      project: before.project,
      panes: before.panes,
      certificates: before.certificates
    })
    expect(patches.map((patch: RevisionedPatch) => openedRepo(patch))).toEqual([shop, shop])
  })

  it('creates one persistent identity for overlapping opens of the same repo', async () => {
    const [first, second] = await Promise.all([service.open(shop), service.open(shop)])
    expect(second.project).toEqual(first.project)
    expect(second.revision).toBe(2)
  })
})

describe('layout and zoom', () => {
  it('keeps a new layout with the project, announces it and logs it', async () => {
    const opened = await service.open(shop)
    const [, tablet] = opened.project!.panes

    const result = await service.setLayout({ layout: 'focus', focusedPane: tablet.id })

    expect(result).toEqual({ layout: 'focus', focusedPane: tablet.id })
    expect(service.snapshot().project).toMatchObject({ layout: 'focus', focusedPane: tablet.id })
    // Kept on disk, which is what makes it survive a restart.
    expect(await store.load(shop)).toMatchObject({
      status: 'loaded',
      project: { layout: 'focus', focusedPane: tablet.id }
    })
    expect(patches.at(-1)).toEqual({
      revision: 2,
      patch: { type: 'project.layout', layout: 'focus', focusedPane: tablet.id }
    })
    expect(log.read().entries).toEqual([
      expect.objectContaining({
        pane: null,
        type: 'project.layoutChanged',
        layout: 'focus',
        focusedPane: tablet.id
      })
    ])
  })

  it('changes the focused pane without being told the layout again', async () => {
    const opened = await service.open(shop)
    const [mobile, , desktop] = opened.project!.panes
    await service.setLayout({ layout: 'focus', focusedPane: mobile.id })

    expect(await service.setLayout({ layout: 'focus', focusedPane: desktop.id })).toEqual({
      layout: 'focus',
      focusedPane: desktop.id
    })
    expect(service.snapshot().project?.focusedPane).toBe(desktop.id)
  })

  it('leaves the focused pane alone when the layout changes without naming one', async () => {
    const opened = await service.open(shop)
    const [, tablet] = opened.project!.panes
    await service.setLayout({ layout: 'focus', focusedPane: tablet.id })

    expect(await service.setLayout({ layout: 'horizontal' })).toEqual({
      layout: 'horizontal',
      focusedPane: tablet.id
    })
  })

  it('refuses to focus a pane the open project does not have, and keeps the layout it had', async () => {
    await service.open(shop)

    await expect(
      service.setLayout({ layout: 'focus', focusedPane: 'ghost' })
    ).rejects.toMatchObject({ code: 'PANE_NOT_FOUND' })
    expect(service.snapshot().project).toMatchObject({ layout: 'horizontal', focusedPane: null })
  })

  it('keeps a zoom with the project, Fit included, and announces it', async () => {
    await service.open(shop)

    expect(await service.setZoom(50)).toEqual({ zoom: 50 })
    expect(await store.load(shop)).toMatchObject({ status: 'loaded', project: { zoom: 50 } })
    expect(patches.at(-1)).toEqual({ revision: 2, patch: { type: 'project.zoom', zoom: 50 } })

    expect(await service.setZoom('fit')).toEqual({ zoom: 'fit' })
    expect(service.snapshot().project?.zoom).toBe('fit')
  })

  it('clamps a zoom past the ends of the control rather than refusing it', async () => {
    await service.open(shop)

    expect(await service.setZoom(400)).toEqual({ zoom: 100 })
    expect(await service.setZoom(-10)).toEqual({ zoom: 25 })
    expect(await service.setZoom(43.4)).toEqual({ zoom: 43 })
    expect(service.snapshot().project?.zoom).toBe(43)
  })

  it('treats the layout or zoom it already has as no change at all', async () => {
    const opened = await service.open(shop)
    const saves = vi.spyOn(store, 'save')

    expect(await service.setLayout({ layout: 'horizontal' })).toEqual({
      layout: 'horizontal',
      focusedPane: null
    })
    expect(await service.setZoom('fit')).toEqual({ zoom: 'fit' })

    expect(saves).not.toHaveBeenCalled()
    expect(log.read().entries).toEqual([])
    expect(service.snapshot()).toEqual(opened)
  })

  it('refuses a layout or zoom change with no project open', async () => {
    await expect(service.setLayout({ layout: 'focus' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_OPEN'
    })
    await expect(service.setZoom(50)).rejects.toMatchObject({ code: 'PROJECT_NOT_OPEN' })
    expect(patches).toEqual([])
  })
})

describe('navigation', () => {
  it('points the project at a URL, keeps it, logs it and announces it', async () => {
    const opened = await service.open(shop)
    const panes = opened.project!.panes.map((pane) => pane.id)

    expect(await service.navigate('http://localhost:3000/checkout', 'window')).toEqual({
      url: 'http://localhost:3000/checkout',
      panes
    })
    expect(await store.load(shop)).toMatchObject({
      status: 'loaded',
      project: { startUrl: 'http://localhost:3000/checkout' }
    })
    expect(patches.at(-1)).toEqual({
      revision: 2,
      patch: { type: 'project.url', url: 'http://localhost:3000/checkout' }
    })
    expect(log.read().entries).toEqual([
      expect.objectContaining({
        pane: null,
        type: 'project.navigated',
        url: 'http://localhost:3000/checkout'
      })
    ])
  })

  it('announces a navigation to the URL it already holds, because a pane may have wandered', async () => {
    const opened = await service.open(shop)
    const saves = vi.spyOn(store, 'save')

    await service.navigate(opened.project!.startUrl, 'window')

    // Nothing to save — the project already said this — but the panes still have to be told.
    expect(saves).not.toHaveBeenCalled()
    expect(patches.at(-1)?.patch).toEqual({
      type: 'project.url',
      url: opened.project!.startUrl
    })
    expect(log.read().entries).toHaveLength(1)
  })

  it('marks every pane loading before it announces the navigation', async () => {
    const opened = await service.open(shop)
    for (const pane of opened.project!.panes) {
      panes.loaded(pane.id, opened.project!.startUrl)
      panes.reportGeometry({
        pane: pane.id,
        expected: { width: pane.width, height: pane.height },
        measured: { width: pane.width, height: pane.height }
      })
    }
    expect(
      Object.values(service.snapshot().panes).every((status) => status.load === 'loaded')
    ).toBe(true)

    const before = patches.length
    await service.navigate('http://localhost:3000/checkout', 'window')

    expect(
      Object.values(service.snapshot().panes).every((status) => status.load === 'pending')
    ).toBe(true)
    expect(patches.slice(before).map(({ patch }) => patch.type)).toEqual([
      'pane.status',
      'pane.status',
      'pane.status',
      'project.url'
    ])
  })

  it('refuses navigation from the CLI outside the allowed origins, and moves nothing', async () => {
    const opened = await service.open(shop)

    await expect(service.navigate('https://evil.example.com/', 'cli')).rejects.toMatchObject({
      code: 'ORIGIN_NOT_ALLOWED',
      details: { url: 'https://evil.example.com/', allowedOrigins: ['http://localhost:3000'] }
    })
    // Only the log moved: the refusal is an observation, and nothing was announced.
    expect(service.snapshot()).toEqual({ ...opened, cursor: 1 })
    expect(patches).toHaveLength(1)
    expect(log.read().entries).toEqual([
      expect.objectContaining({
        pane: null,
        type: 'project.navigationRefused',
        url: 'https://evil.example.com/'
      })
    ])
  })

  it('never holds the window to the allowed origins, however far outside they are', async () => {
    await service.open(shop)

    expect(await service.navigate('https://evil.example.com/', 'window')).toMatchObject({
      url: 'https://evil.example.com/'
    })
    expect(service.snapshot().project?.startUrl).toBe('https://evil.example.com/')
  })

  it('lets the CLI navigate anywhere inside the allowed origins', async () => {
    await service.open(shop)

    expect(await service.navigate('http://localhost:3000/cart?step=1', 'cli')).toMatchObject({
      url: 'http://localhost:3000/cart?step=1'
    })
  })

  it('refuses navigation with no project open', async () => {
    await expect(service.navigate('http://localhost:3000/', 'cli')).rejects.toMatchObject({
      code: 'PROJECT_NOT_OPEN'
    })
    expect(patches).toEqual([])
  })
})

describe('allowed origins', () => {
  it('replaces them as origins, keeps them, logs them and announces them', async () => {
    await service.open(shop)

    expect(
      await service.setAllowedOrigins(['http://localhost:3000', 'https://staging.example.com/app'])
    ).toEqual({ origins: ['http://localhost:3000', 'https://staging.example.com'] })
    expect(await store.load(shop)).toMatchObject({
      status: 'loaded',
      project: { allowedOrigins: ['http://localhost:3000', 'https://staging.example.com'] }
    })
    expect(patches.at(-1)).toEqual({
      revision: 2,
      patch: {
        type: 'project.allowedOrigins',
        origins: ['http://localhost:3000', 'https://staging.example.com']
      }
    })
    expect(log.read().entries).toEqual([
      expect.objectContaining({ pane: null, type: 'project.originsChanged' })
    ])
  })

  it('binds the next navigation from the CLI', async () => {
    await service.open(shop)
    await service.setAllowedOrigins(['https://staging.example.com'])

    await expect(service.navigate('http://localhost:3000/', 'cli')).rejects.toMatchObject({
      code: 'ORIGIN_NOT_ALLOWED'
    })
    expect(await service.navigate('https://staging.example.com/cart', 'cli')).toMatchObject({
      url: 'https://staging.example.com/cart'
    })
  })

  it('accepts an empty list, which allows automation nothing', async () => {
    await service.open(shop)

    expect(await service.setAllowedOrigins([])).toEqual({ origins: [] })
    await expect(service.navigate('http://localhost:3000/', 'cli')).rejects.toMatchObject({
      code: 'ORIGIN_NOT_ALLOWED'
    })
  })

  it('refuses a list with an entry that is not a web URL, and keeps the list it had', async () => {
    const opened = await service.open(shop)

    await expect(service.setAllowedOrigins(['localhost:3000'])).rejects.toMatchObject({
      code: 'INVALID_PARAMS'
    })
    expect(service.snapshot()).toEqual(opened)
  })

  it('treats the list it already holds as no change at all', async () => {
    const opened = await service.open(shop)
    const saves = vi.spyOn(store, 'save')

    expect(await service.setAllowedOrigins(['http://localhost:3000/'])).toEqual({
      origins: ['http://localhost:3000']
    })
    expect(saves).not.toHaveBeenCalled()
    expect(service.snapshot()).toEqual(opened)
  })

  it('refuses an edit with no project open', async () => {
    await expect(service.setAllowedOrigins([])).rejects.toMatchObject({
      code: 'PROJECT_NOT_OPEN'
    })
  })
})

describe('the project list the switcher reads', () => {
  it('is empty before anything has been stored, rather than a failure', async () => {
    expect(await service.list()).toEqual({ projects: [] })
  })

  it('is the project directory read, in name order', async () => {
    const admin = join(root, 'admin')
    await mkdir(admin)
    await service.open(shop)
    await service.open(admin)

    expect((await service.list()).projects).toEqual([
      { file: projectFileName(admin), openable: true, name: 'admin', repoPath: admin },
      { file: projectFileName(shop), openable: true, name: 'shop', repoPath: shop }
    ])
  })

  it('sees a project this run never opened, because nothing but the directory is the list', async () => {
    await store.save(createProject(other))

    expect((await service.list()).projects).toMatchObject([
      { openable: true, name: 'other', repoPath: other }
    ])
  })

  it('lists a file written by a newer build as unopenable, keeping the name it can still read', async () => {
    await service.open(shop)
    const file = store.fileFor(other)
    await writeFile(
      file,
      JSON.stringify({ version: 99, project: { name: 'other', repoPath: other } })
    )

    const { projects } = await service.list()

    expect(projects).toEqual([
      {
        file: projectFileName(other),
        openable: false,
        name: 'other',
        repoPath: other,
        reason: 'newer',
        message: expect.stringContaining('file version 99')
      },
      { file: projectFileName(shop), openable: true, name: 'shop', repoPath: shop }
    ])
  })

  it('lists a file that is not JSON under its own name, and still lists the rest', async () => {
    await service.open(shop)
    await writeFile(join(root, 'projects', 'aaaa.json'), 'not json at all')

    expect((await service.list()).projects).toEqual([
      {
        file: 'aaaa.json',
        openable: false,
        name: null,
        repoPath: null,
        reason: 'corrupt',
        message: 'the file is not JSON'
      },
      { file: projectFileName(shop), openable: true, name: 'shop', repoPath: shop }
    ])
  })

  it('refuses a file that is not the one its repo path is stored in, so the open cannot open something else', async () => {
    await service.open(shop)
    await writeFile(
      join(root, 'projects', 'aaaa.json'),
      JSON.stringify(writeProjectFile(createProject(other)))
    )

    expect((await service.list()).projects[0]).toMatchObject({
      file: 'aaaa.json',
      openable: false,
      name: 'other',
      repoPath: other,
      reason: 'corrupt'
    })
  })

  it('ignores a partial write left beside a project file', async () => {
    await service.open(shop)
    await writeFile(`${store.fileFor(shop)}.999.tmp`, '{')

    expect((await service.list()).projects).toHaveLength(1)
  })
})
