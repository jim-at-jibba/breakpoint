import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PRESETS, readPresetFile, writePresetFile, type Preset } from '../../shared/presets'
import { PresetService } from './preset-service'
import { PresetStore } from './preset-store'

let root: string
let store: PresetStore
let service: PresetService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-preset-test-'))
  store = new PresetStore(join(root, 'presets.json'))
  service = new PresetService(store)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeRaw(raw: unknown): Promise<void> {
  await writeFile(store.file, JSON.stringify(raw))
}

describe('the first read', () => {
  it('seeds the file with the seven defaults and returns them', async () => {
    expect(await service.list()).toEqual({ presets: [...DEFAULT_PRESETS] })

    const written: unknown = JSON.parse(await readFile(store.file, 'utf8'))
    expect(readPresetFile(written)).toEqual({ ok: true, presets: [...DEFAULT_PRESETS] })
  })

  it('serialises overlapping seeds so every caller succeeds', async () => {
    vi.spyOn(store, 'load')
      .mockResolvedValueOnce({ status: 'missing' })
      .mockResolvedValueOnce({ status: 'missing' })
    let active = 0
    let mostActive = 0
    vi.spyOn(store, 'save').mockImplementation(async () => {
      active += 1
      mostActive = Math.max(mostActive, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
    })

    const results = await Promise.all([service.list(), service.list()])

    expect(results).toEqual([{ presets: [...DEFAULT_PRESETS] }, { presets: [...DEFAULT_PRESETS] }])
    expect(mostActive).toBe(1)
  })
})

describe('reading an existing file', () => {
  it('returns what the developer edited, not the defaults', async () => {
    const edited: Preset[] = [
      ...DEFAULT_PRESETS.map((preset) =>
        preset.id === 'mobile' ? { ...preset, width: 320, height: 568 } : preset
      ),
      {
        id: 'watch',
        name: 'Watch',
        width: 396,
        height: 484,
        dpr: 2,
        mobile: true,
        touch: true,
        userAgent: null
      }
    ]
    await writeRaw(writePresetFile(edited))

    expect((await service.list()).presets).toEqual(edited)
  })

  /** The file is the developer's to edit while the app runs; nothing caches it past a call. */
  it('sees an edit made between two reads', async () => {
    const before = await service.list()
    const edited = before.presets.map((preset) =>
      preset.id === 'tablet' ? { ...preset, width: 768 } : preset
    )
    await writeRaw(writePresetFile(edited))

    expect((await service.list()).presets).toEqual(edited)
  })
})

describe('a file that cannot be read', () => {
  it.each([
    ['is not JSON', '{'],
    ['is not a preset file', JSON.stringify({ version: 1, presets: [{ id: 'x' }] })]
  ])('refuses with a stable code and names the file when it %s', async (_label, text) => {
    await writeFile(store.file, text)

    await expect(service.list()).rejects.toMatchObject({
      code: 'PRESETS_UNREADABLE',
      details: { reason: 'corrupt', file: store.file }
    })
  })

  it('refuses a file a newer build wrote rather than reading past it', async () => {
    await writeRaw({ ...writePresetFile(DEFAULT_PRESETS), version: 99 })

    await expect(service.list()).rejects.toMatchObject({
      code: 'PRESETS_UNREADABLE',
      details: { reason: 'newer' }
    })
  })

  it('leaves the file exactly as it found it, so a typo is never made permanent', async () => {
    const broken = '{ "version": 1, "presets": [ oops ] }'
    await writeFile(store.file, broken)

    await expect(service.list()).rejects.toThrow()
    expect(await readFile(store.file, 'utf8')).toBe(broken)
  })
})
