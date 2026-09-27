import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleEntryBody, SourceLocation, StackFrame } from './event-log'
import { RESOLUTION_TIMEOUT_MS, repoPathFor, resolveEntry, type IsFile } from './resolution'

const PAGE = 'http://localhost:5173/checkout'
const REPO = '/Users/ada/shop'
const APP = 'http://localhost:5173/src/App.tsx?t=1712'
const BUNDLE = 'http://localhost:5173/assets/index-4f2a.js'

function at(url: string, line: number, column = 1): SourceLocation {
  return { url, line, column, resolution: 'failed', path: null }
}

function frame(name: string, url: string, line: number): StackFrame {
  return { function: name, ...at(url, line, 3) }
}

function exception(stack: StackFrame[]): ConsoleEntryBody {
  const [first] = stack
  return {
    type: 'console.exception',
    rejection: false,
    text: 'Uncaught TypeError: nope',
    error: 'TypeError: nope',
    location: first ? at(first.url, first.line, first.column) : null,
    stack
  }
}

/** A repo holding exactly these files. */
function files(...paths: string[]): IsFile {
  return (absolute) => Promise.resolve(paths.some((path) => `${REPO}/${path}` === absolute))
}

describe('repoPathFor', () => {
  it('reads a dev server URL as the repo path it was asked for', () => {
    expect(repoPathFor(APP, PAGE)).toBe('src/App.tsx')
    expect(repoPathFor('http://localhost:5173/src/My%20Page.tsx', PAGE)).toBe('src/My Page.tsx')
  })

  it('names nothing for a script from another origin, however repo-shaped', () => {
    expect(repoPathFor('https://cdn.example.com/src/App.tsx', PAGE)).toBeNull()
    expect(repoPathFor('http://localhost:5174/src/App.tsx', PAGE)).toBeNull()
  })

  it('names nothing that is not a path, or that could leave the repo', () => {
    for (const url of [
      '',
      'not a url',
      'http://localhost:5173/',
      'http://localhost:5173/src/',
      'http://localhost:5173/src/%2e%2e%2f..%2fsecrets',
      'http://localhost:5173/src%2F..%2F..%2Fetc%2Fpasswd',
      'http://localhost:5173/%E0%A4%A',
      'http://localhost:5173/src/a%00.js',
      'data:text/javascript,1',
      'chrome-extension://abc/src/App.tsx'
    ]) {
      expect(repoPathFor(url, PAGE), url).toBeNull()
    }
  })
})

describe('resolveEntry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the location and every frame that names a file in the repo', async () => {
    const body = exception([frame('render', APP, 12), frame('', BUNDLE, 1)])
    const resolved = await resolveEntry(body, { repoPath: REPO, page: PAGE }, files('src/App.tsx'))
    expect(resolved).toMatchObject({
      location: { url: APP, line: 12, column: 3, resolution: 'resolved', path: 'src/App.tsx' },
      stack: [
        { function: 'render', url: APP, line: 12, resolution: 'resolved', path: 'src/App.tsx' },
        // Named no file on disk, so it is exactly as the page reported it.
        { function: '', url: BUNDLE, line: 1, column: 3, resolution: 'failed', path: null }
      ]
    })
  })

  it('asks the disk once per script, however many frames name it', async () => {
    const isFile = vi.fn(files('src/App.tsx'))
    await resolveEntry(
      exception([frame('a', APP, 1), frame('b', APP, 2), frame('c', APP, 3)]),
      { repoPath: REPO, page: PAGE },
      isFile
    )
    expect(isFile).toHaveBeenCalledTimes(1)
    expect(isFile).toHaveBeenCalledWith(`${REPO}/src/App.tsx`)
  })

  it('leaves everything unresolved for a project with no repo path, and asks nothing', async () => {
    const isFile = vi.fn(files('src/App.tsx'))
    const body = exception([frame('render', APP, 12)])
    const resolved = await resolveEntry(body, { repoPath: null, page: PAGE }, isFile)
    expect(resolved).toEqual(body)
    expect(isFile).not.toHaveBeenCalled()
  })

  it('treats a disk that throws as a script it cannot find', async () => {
    const body = exception([frame('render', APP, 12)])
    const resolved = await resolveEntry(body, { repoPath: REPO, page: PAGE }, () =>
      Promise.reject(new Error('EACCES'))
    )
    expect(resolved).toEqual(body)
  })

  it('gives up at the timeout, keeping whatever resolved before it', async () => {
    vi.useFakeTimers()
    const slow = 'http://localhost:5173/src/slow.ts'
    const isFile: IsFile = (absolute) =>
      absolute.endsWith('slow.ts') ? new Promise(() => {}) : Promise.resolve(true)
    const pending = resolveEntry(
      exception([frame('slow', slow, 4), frame('render', APP, 12)]),
      { repoPath: REPO, page: PAGE },
      isFile
    )
    await vi.advanceTimersByTimeAsync(RESOLUTION_TIMEOUT_MS)
    const resolved = await pending
    expect(resolved.location).toEqual(at(slow, 4, 3))
    expect(resolved.stack.map((each) => each.resolution)).toEqual(['failed', 'resolved'])
  })

  it('resolves a repo path written with a trailing separator', async () => {
    const resolved = await resolveEntry(
      exception([frame('render', APP, 12)]),
      { repoPath: `${REPO}/`, page: PAGE },
      files('src/App.tsx')
    )
    expect(resolved.location?.path).toBe('src/App.tsx')
  })

  it('resolves a browser message location, and leaves one with none alone', async () => {
    const message: ConsoleEntryBody = {
      type: 'console.message',
      level: 'warn',
      source: 'console',
      text: 'careful',
      args: ['careful'],
      url: null,
      location: at(APP, 7),
      stack: []
    }
    const context = { repoPath: REPO, page: PAGE }
    expect((await resolveEntry(message, context, files('src/App.tsx'))).location).toEqual({
      url: APP,
      line: 7,
      column: 1,
      resolution: 'resolved',
      path: 'src/App.tsx'
    })
    const nowhere = { ...message, location: null }
    expect(await resolveEntry(nowhere, context, files('src/App.tsx'))).toEqual(nowhere)
  })
})
