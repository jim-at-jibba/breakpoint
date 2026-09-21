import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, writeProjectFile, type Project } from '../../shared/project'
import type { RevisionedPatch } from '../../shared/state'
import { StateFeed } from '../state-feed'
import { ProjectService } from './project-service'
import { ProjectStore } from './project-store'

let root: string
let shop: string
let other: string
let store: ProjectStore
let service: ProjectService
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
  service = new ProjectService(store, feed)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
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
    expect(service.snapshot()).toEqual(before)
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
    expect(service.snapshot()).toEqual({ revision: 0, project: null })
    expect(patches).toEqual([])
    expect(store.save).toHaveBeenCalledTimes(1)

    finishSave()
    const [openedShop, openedOther] = await Promise.all([first, second])
    expect(openedShop.revision).toBe(1)
    expect(openedOther.revision).toBe(2)
    expect(patches.map((patch: RevisionedPatch) => patch.patch.project.repoPath)).toEqual([
      shop,
      other
    ])
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
    expect(service.snapshot()).toEqual(before)
    expect(await store.load(other)).toEqual({ status: 'missing' })
    await expect(reopened).resolves.toEqual({ revision: 2, project: before.project })
    expect(patches.map((patch: RevisionedPatch) => patch.patch.project.repoPath)).toEqual([
      shop,
      shop
    ])
  })

  it('creates one persistent identity for overlapping opens of the same repo', async () => {
    const [first, second] = await Promise.all([service.open(shop), service.open(shop)])
    expect(second.project).toEqual(first.project)
    expect(second.revision).toBe(2)
  })
})
