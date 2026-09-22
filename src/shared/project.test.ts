import { describe, expect, it } from 'vitest'
import { DEFAULT_PRESETS, type Preset } from './presets'
import {
  createProject,
  PROJECT_FILE_VERSION,
  PROJECT_MIGRATIONS,
  projectFileName,
  readProjectFile,
  writeProjectFile,
  type ProjectMigrations
} from './project'

describe('createProject', () => {
  it('names the project after the repo directory and starts it on localhost', () => {
    const project = createProject('/Users/dev/code/shop')

    expect(project.name).toBe('shop')
    expect(project.repoPath).toBe('/Users/dev/code/shop')
    expect(project.startUrl).toBe('http://localhost:3000')
    expect(project.allowedOrigins).toEqual(['http://localhost:3000'])
    expect(project.layout).toBe('horizontal')
    expect(project.zoom).toBe('fit')
    expect(project.focusedPane).toBeNull()
  })

  it('gives a new project the PRD 6.2 default pane set on one shared session', () => {
    const project = createProject('/Users/dev/code/shop')

    expect(project.sessions).toEqual([{ id: 'default', name: 'Default' }])
    expect(project.panes.map((pane) => [pane.name, pane.width, pane.height, pane.dpr])).toEqual([
      ['Mobile', 390, 844, 3],
      ['Tablet', 820, 1180, 2],
      ['Desktop', 1440, 900, 1]
    ])
    expect(project.panes.map((pane) => pane.mobile)).toEqual([true, true, false])
    expect(project.panes.map((pane) => pane.touch)).toEqual([true, true, false])
    for (const pane of project.panes) {
      expect(pane.session).toBe('default')
      expect(pane.colorScheme).toBe('system')
      expect(pane.userAgent).toBeNull()
    }
    expect(project.panes.map((pane) => pane.preset)).toEqual(['mobile', 'tablet', 'desktop'])
    expect(new Set(project.panes.map((pane) => pane.id)).size).toBe(3)
  })

  it('resolves its panes from the presets it is given, not from a set of its own', () => {
    const edited: Preset[] = DEFAULT_PRESETS.map((preset) =>
      preset.id === 'mobile'
        ? { ...preset, width: 320, height: 568, name: 'Mobile (small)' }
        : preset
    )

    const project = createProject('/Users/dev/code/shop', edited)

    expect(project.panes[0]).toMatchObject({ name: 'Mobile (small)', width: 320, height: 568 })
    expect(project.panes[1]).toMatchObject({ name: 'Tablet', width: 820 })
  })

  it('falls back to the built-in preset for a default the user has deleted', () => {
    const project = createProject(
      '/Users/dev/code/shop',
      DEFAULT_PRESETS.filter((preset) => preset.id !== 'tablet')
    )

    expect(project.panes[1]).toMatchObject(
      expect.objectContaining({ name: 'Tablet', width: 820, height: 1180 })
    )
  })
})

describe('projectFileName', () => {
  it('keys the file on a hash of the repo path, so no path character reaches the file system', () => {
    const name = projectFileName('/Users/dev/code/shop')
    expect(name).toMatch(/^[0-9a-f]{32}\.json$/)
    expect(projectFileName('/Users/dev/code/shop')).toBe(name)
    expect(projectFileName('/Users/dev/code/store')).not.toBe(name)
  })
})

describe('readProjectFile', () => {
  const stored = createProject('/Users/dev/code/shop')

  it('reads a file written by this build back as the project it holds', () => {
    const raw = JSON.parse(JSON.stringify(writeProjectFile(stored)))
    expect(readProjectFile(raw)).toEqual({ ok: true, project: stored })
  })

  it.each(['file:///tmp/page.html', 'data:text/html,test', 'javascript:alert(1)', '/relative'])(
    'refuses a project that starts on %s',
    (startUrl: string): void => {
      expect(readProjectFile(writeProjectFile({ ...stored, startUrl }))).toEqual({
        ok: false,
        reason: 'corrupt',
        message: 'the project inside the file is not a project'
      })
    }
  )

  it('refuses a file whose version is higher than the build, and says which', () => {
    const raw = { ...writeProjectFile(stored), version: PROJECT_FILE_VERSION + 1 }
    expect(readProjectFile(raw)).toEqual({
      ok: false,
      reason: 'newer',
      message: `written by a newer Breakpoint (file version ${PROJECT_FILE_VERSION + 1}, this build reads ${PROJECT_FILE_VERSION})`
    })
  })

  it.each([
    ['not an object', 42],
    ['no version', { project: stored }],
    ['a non-integer version', { version: 1.5, project: stored }],
    ['no project', { version: PROJECT_FILE_VERSION }],
    [
      'a project with no repo path',
      { version: PROJECT_FILE_VERSION, project: { ...stored, repoPath: 7 } }
    ],
    [
      'a pane with a string width',
      {
        version: PROJECT_FILE_VERSION,
        project: { ...stored, panes: [{ ...stored.panes[0], width: '390' }] }
      }
    ],
    [
      'an unknown layout',
      { version: PROJECT_FILE_VERSION, project: { ...stored, layout: 'grid' } }
    ],
    [
      'a zoom outside 25 to 100',
      { version: PROJECT_FILE_VERSION, project: { ...stored, zoom: 150 } }
    ],
    [
      'a pane on a session the project does not have',
      {
        version: PROJECT_FILE_VERSION,
        project: { ...stored, panes: [{ ...stored.panes[0], session: 'ghost' }] }
      }
    ],
    [
      'a pane with no touch setting',
      {
        version: PROJECT_FILE_VERSION,
        project: { ...stored, panes: [{ ...stored.panes[0], touch: undefined }] }
      }
    ],
    [
      'a pane with a numeric user agent',
      {
        version: PROJECT_FILE_VERSION,
        project: { ...stored, panes: [{ ...stored.panes[0], userAgent: 7 }] }
      }
    ],
    [
      'a pane wider than a pane may be',
      {
        version: PROJECT_FILE_VERSION,
        project: { ...stored, panes: [{ ...stored.panes[0], width: 1_000_000 }] }
      }
    ]
  ])('refuses a corrupt file: %s', (_label, raw) => {
    const result = readProjectFile(raw)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('corrupt')
  })

  /**
   * Version 2 had no `touch` and no `userAgent`: touch followed the mobile flag, and the
   * user agent was always Breakpoint's own. Both carried forward as they were in force.
   */
  it('migrates a version 2 file by giving each pane the touch and user agent it had', () => {
    const before = {
      version: 2,
      project: {
        ...stored,
        panes: stored.panes.map((pane) => {
          const older: Record<string, unknown> = { ...pane }
          delete older.touch
          delete older.userAgent
          return older
        })
      }
    }

    const result = readProjectFile(before, {
      version: PROJECT_FILE_VERSION,
      migrations: PROJECT_MIGRATIONS
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.project.panes.map((pane) => pane.touch)).toEqual(
      stored.panes.map((pane) => pane.mobile)
    )
    expect(result.ok && result.project.panes.every((pane) => pane.userAgent === null)).toBe(true)
  })

  it('migrates an older file forward one version at a time', () => {
    const steps: number[] = []
    const migrations: ProjectMigrations = {
      1: (file) => {
        steps.push(1)
        return { ...file, renamed: file.title }
      },
      2: (file) => {
        steps.push(2)
        return { ...file, project: { ...stored, name: file.renamed as string } }
      }
    }
    const result = readProjectFile({ version: 1, title: 'old' }, { version: 3, migrations })

    expect(steps).toEqual([1, 2])
    expect(result).toEqual({ ok: true, project: { ...stored, name: 'old' } })
  })

  it('brings a version 2 pane whose size the current rules refuse into range', () => {
    const before = {
      version: 2,
      project: {
        ...stored,
        panes: stored.panes.map((pane, index) => {
          const older: Record<string, unknown> = { ...pane }
          delete older.touch
          delete older.userAgent
          return { ...older, width: [390.5, 1_000_000, 0][index] }
        })
      }
    }

    const result = readProjectFile(before, {
      version: PROJECT_FILE_VERSION,
      migrations: PROJECT_MIGRATIONS
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.project.panes.map((pane) => pane.width)).toEqual([391, 10_000, 1])
    // Heights the rules already accept are untouched.
    expect(result.ok && result.project.panes.map((pane) => pane.height)).toEqual(
      stored.panes.map((pane) => pane.height)
    )
  })

  it('reads a focused pane the project no longer has as focusing none', () => {
    const raw = writeProjectFile({ ...stored, focusedPane: 'ghost' })

    expect(readProjectFile(raw)).toEqual({ ok: true, project: { ...stored, focusedPane: null } })
  })

  it('still refuses a focused pane that is not a pane id at all', () => {
    const raw = writeProjectFile({ ...stored, focusedPane: 7 as unknown as string })

    expect(readProjectFile(raw).ok).toBe(false)
  })

  it('reads a file from before Focus remembered its pane as focusing none', () => {
    const before: Record<string, unknown> = { ...stored }
    delete before.focusedPane
    const result = readProjectFile({ version: 1, project: before })

    expect(result).toEqual({ ok: true, project: { ...stored, focusedPane: null } })
  })

  it('treats a missing migration step as corruption rather than skipping it', () => {
    const result = readProjectFile({ version: 1, project: stored }, { version: 3, migrations: {} })
    expect(result.ok === false && result.reason).toBe('corrupt')
  })
})
