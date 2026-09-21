import { describe, expect, it } from 'vitest'
import {
  createProject,
  PROJECT_FILE_VERSION,
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
    for (const pane of project.panes) {
      expect(pane.session).toBe('default')
      expect(pane.colorScheme).toBe('system')
    }
    expect(new Set(project.panes.map((pane) => pane.id)).size).toBe(3)
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
    ]
  ])('refuses a corrupt file: %s', (_label, raw) => {
    const result = readProjectFile(raw)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('corrupt')
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
