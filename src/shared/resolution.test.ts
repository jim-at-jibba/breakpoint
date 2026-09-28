import { transformWithEsbuild } from 'vite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConsoleEntryBody, SourceLocation, StackFrame } from './event-log'
import {
  RESOLUTION_TIMEOUT_MS,
  repoPathFor,
  resolveEntry,
  type FetchText,
  type Fetched,
  type IsFile,
  type ResolutionIO
} from './resolution'

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

/** A network that answers nothing, as if every script were a dev server's own. */
const offline: FetchText = () => Promise.resolve(null)

/** A repo holding exactly these files, on a network that answers nothing. */
function repo(...paths: string[]): ResolutionIO {
  return { isFile: files(...paths), fetch: offline }
}

describe('repoPathFor', () => {
  it('reads a dev server URL as the repo path it was asked for', () => {
    expect(repoPathFor(APP, PAGE)).toBe('src/App.tsx')
    expect(repoPathFor('http://localhost:5173/src/My%20Page.tsx', PAGE)).toBe('src/My Page.tsx')
  })

  it('reads through the cache-busting a dev server adds, which leaves the file as it is', () => {
    for (const query of ['?t=1712', '?v=4f2a', '?v=4f2a&t=1712', '?']) {
      expect(repoPathFor(`http://localhost:5173/src/App.tsx${query}`, PAGE), query).toBe(
        'src/App.tsx'
      )
    }
  })

  it('names nothing for a virtual module, however much it looks like the file it came from', () => {
    for (const query of [
      '?astro&type=script&index=0&lang.ts',
      '?vue&type=script&setup=true&lang.ts',
      '?svelte&type=style&lang.css',
      '?import',
      '?t=1712&astro&type=script&index=0&lang.ts'
    ]) {
      expect(repoPathFor(`http://localhost:5173/src/pages/Page.astro${query}`, PAGE), query).toBe(
        null
      )
    }
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
    const resolved = await resolveEntry(body, { repoPath: REPO, page: PAGE }, repo('src/App.tsx'))
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
      { isFile, fetch: offline }
    )
    expect(isFile).toHaveBeenCalledTimes(1)
    expect(isFile).toHaveBeenCalledWith(`${REPO}/src/App.tsx`)
  })

  it('leaves everything unresolved for a project with no repo path, and asks nothing', async () => {
    const isFile = vi.fn(files('src/App.tsx'))
    const body = exception([frame('render', APP, 12)])
    const resolved = await resolveEntry(
      body,
      { repoPath: null, page: PAGE },
      { isFile, fetch: offline }
    )
    expect(resolved).toEqual(body)
    expect(isFile).not.toHaveBeenCalled()
  })

  it('treats a disk that throws as a script it cannot find', async () => {
    const body = exception([frame('render', APP, 12)])
    const resolved = await resolveEntry(
      body,
      { repoPath: REPO, page: PAGE },
      {
        isFile: () => Promise.reject(new Error('EACCES')),
        fetch: offline
      }
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
      { isFile, fetch: offline }
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
      repo('src/App.tsx')
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
    expect((await resolveEntry(message, context, repo('src/App.tsx'))).location).toEqual({
      url: APP,
      line: 7,
      column: 1,
      resolution: 'resolved',
      path: 'src/App.tsx'
    })
    const nowhere = { ...message, location: null }
    expect(await resolveEntry(nowhere, context, repo('src/App.tsx'))).toEqual(nowhere)
  })
})

describe('resolveEntry through a source map', () => {
  const SOURCE = `export function total(items) {
  if (items.length === 0) {
    throw new TypeError('empty')
  }
  return items.length
}
`
  const MAP_URL = `${BUNDLE}.map`
  /** The minified bundle, all on line 1, and its map as the bundler wrote it. */
  let code: string
  let generated: { sources: string[] } & Record<string, unknown>
  /** Where in the bundle the `throw` on line 3, column 5, of the source ended up. */
  let thrownAt: number

  beforeAll(async () => {
    const built = await transformWithEsbuild(SOURCE, 'src/checkout.js', {
      minify: true,
      sourcemap: true,
      format: 'iife'
    })
    code = built.code
    generated = built.map as unknown as typeof generated
    expect(code.trimEnd()).not.toContain('\n')
    thrownAt = code.indexOf('throw') + 1
  })

  /** The map, naming its one source the way a particular bundler would. */
  function mapNaming(source: string): string {
    return JSON.stringify({ ...generated, sources: [source] })
  }

  function served(text: string, headers: Record<string, string> = {}): Fetched {
    return { text, header: (name) => headers[name.toLowerCase()] ?? null }
  }

  /** A network serving exactly these responses, and nothing for any other URL. */
  function network(routes: Record<string, Fetched>): FetchText & ReturnType<typeof vi.fn> {
    return vi.fn<FetchText>((url) => Promise.resolve(routes[url] ?? null))
  }

  /** The production-style bundle and its map, the way a build serves them. */
  function bundled(source = '../../src/checkout.js'): Record<string, Fetched> {
    return {
      [BUNDLE]: served(`${code}//# sourceMappingURL=index-4f2a.js.map\n`),
      [MAP_URL]: served(mapNaming(source))
    }
  }

  const context = { repoPath: REPO, page: PAGE }

  it('follows the map of a script no repo file answers to the file and position it came from', async () => {
    const fetch = network(bundled())
    const body = exception([frame('r', BUNDLE, 1), frame('', BUNDLE, 1)])
    const thrown = { ...body, stack: [{ ...body.stack[0], column: thrownAt }, body.stack[1]] }
    const resolved = await resolveEntry({ ...thrown, location: at(BUNDLE, 1, thrownAt) }, context, {
      isFile: files('src/checkout.js'),
      fetch
    })
    const there = {
      url: BUNDLE,
      line: 3,
      column: 5,
      resolution: 'resolved',
      path: 'src/checkout.js'
    }
    expect(resolved.location).toEqual(there)
    expect(resolved.stack).toEqual([
      { function: 'r', ...there },
      // Column 3 is the bundle's own wrapper, which the map says nothing about.
      { function: '', url: BUNDLE, line: 1, column: 3, resolution: 'failed', path: null }
    ])
    // The script and its map, once each, however many locations are in it.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([BUNDLE, MAP_URL])
  })

  it('fetches nothing for a script the arithmetic already found', async () => {
    const fetch = network(bundled())
    await resolveEntry(exception([frame('render', APP, 12)]), context, {
      isFile: files('src/App.tsx'),
      fetch
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches nothing for a project with no repo path', async () => {
    const fetch = network(bundled())
    const body = exception([frame('r', BUNDLE, 1)])
    expect(
      await resolveEntry(body, { repoPath: null, page: PAGE }, { isFile: files(), fetch })
    ).toEqual(body)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('follows a map named by a header, or carried inline', async () => {
    const byHeader = network({
      [BUNDLE]: served(code, { sourcemap: '/maps/index.map' }),
      'http://localhost:5173/maps/index.map': served(mapNaming('../src/checkout.js'))
    })
    const inline = `data:application/json;base64,${btoa(mapNaming('../src/checkout.js'))}`
    const carried = network({ [BUNDLE]: served(`${code}//# sourceMappingURL=${inline}\n`) })

    for (const fetch of [byHeader, carried]) {
      const thrown = await resolveEntry(
        { ...exception([]), location: at(BUNDLE, 1, thrownAt) },
        context,
        { isFile: files('src/checkout.js'), fetch }
      )
      expect(thrown.location).toMatchObject({ line: 3, path: 'src/checkout.js' })
    }
  })

  it('reads a source however the bundler wrote it', async () => {
    for (const source of [
      '../../src/checkout.js',
      'webpack://shop/./src/checkout.js',
      'webpack:///./src/checkout.js',
      `${REPO}/src/checkout.js`,
      `file://${REPO}/src/checkout.js`,
      'src/checkout.js'
    ]) {
      const resolved = await resolveEntry(
        { ...exception([]), location: at(BUNDLE, 1, thrownAt) },
        context,
        { isFile: files('src/checkout.js'), fetch: network(bundled(source)) }
      )
      expect(resolved.location, source).toMatchObject({
        resolution: 'resolved',
        path: 'src/checkout.js',
        line: 3
      })
    }
  })

  it('reads a source under the root the map names for its sources', async () => {
    const fetch = network({
      [BUNDLE]: bundled()[BUNDLE],
      [MAP_URL]: served(
        JSON.stringify({
          ...generated,
          sourceRoot: 'webpack://shop',
          sources: ['./src/checkout.js']
        })
      )
    })
    const resolved = await resolveEntry(
      { ...exception([]), location: at(BUNDLE, 1, thrownAt) },
      context,
      { isFile: files('src/checkout.js'), fetch }
    )
    expect(resolved.location).toMatchObject({ resolution: 'resolved', path: 'src/checkout.js' })
  })

  it('resolves no source that lives outside the repo, however its tail reads', async () => {
    // A repo in which every file but the bundle exists: only a source read as outside it
    // can fail.
    const everything: IsFile = (absolute) => Promise.resolve(!absolute.endsWith('index-4f2a.js'))
    for (const source of [
      '/Users/ada/elsewhere/src/checkout.js',
      'file:///Users/ada/elsewhere/src/checkout.js',
      `${REPO}/../ui/src/checkout.js`,
      'webpack://shop/../ui/src/checkout.js'
    ]) {
      const resolved = await resolveEntry(
        { ...exception([]), location: at(BUNDLE, 1, thrownAt) },
        context,
        { isFile: everything, fetch: network(bundled(source)) }
      )
      expect(resolved.location, source).toMatchObject({ resolution: 'failed', path: null })
    }
  })

  it('never asks the disk about a path outside the repo, whatever a map says', async () => {
    const asked: string[] = []
    const isFile: IsFile = (absolute) => {
      asked.push(absolute)
      return Promise.resolve(false)
    }
    for (const source of [
      '/etc/passwd',
      'file:///etc/passwd',
      '../../../../../etc/passwd',
      'webpack://x/../../../etc/passwd',
      'src/../../../etc/passwd',
      'src/%2e%2e/%2e%2e/etc/passwd',
      `${REPO}/../elsewhere/secret.js`
    ]) {
      await resolveEntry({ ...exception([]), location: at(BUNDLE, 1, thrownAt) }, context, {
        isFile,
        fetch: network(bundled(source))
      })
    }
    expect(asked.length).toBeGreaterThan(0)
    for (const absolute of asked) {
      expect(absolute.startsWith(`${REPO}/`), absolute).toBe(true)
      expect(absolute.slice(REPO.length + 1).split('/'), absolute).not.toContain('..')
    }
  })

  it('appends as reported, and flagged, when the map is missing, unreachable or malformed', async () => {
    const body = { ...exception([frame('r', BUNDLE, 1)]), location: at(BUNDLE, 1, thrownAt) }
    const withMap = (map: Fetched | undefined): FetchText =>
      network({ [BUNDLE]: bundled()[BUNDLE], ...(map ? { [MAP_URL]: map } : {}) })
    for (const [why, fetch] of [
      ['names no map', network({ [BUNDLE]: served(code) })],
      ['the script cannot be fetched', network({})],
      ['the map is not there', withMap(undefined)],
      ['the network fails', () => Promise.reject(new TypeError('fetch failed'))],
      ['the map is not JSON', withMap(served('{"version":3,'))],
      ['the map is not a map', withMap(served('[]'))],
      ['the map names a file the repo lacks', withMap(served(mapNaming('../../src/gone.js')))],
      [
        'the map is not on the web',
        network({ [BUNDLE]: served(`${code}//# sourceMappingURL=file:///tmp/index.map\n`) })
      ],
      [
        'the inline map does not decode',
        network({ [BUNDLE]: served(`${code}//# sourceMappingURL=data:;base64,%%%\n`) })
      ]
    ] as const) {
      expect(
        await resolveEntry(body, context, { isFile: files('src/checkout.js'), fetch }),
        why
      ).toEqual(body)
    }
  })

  it('fetches only a script on the web', async () => {
    const fetch = network({})
    await resolveEntry(
      exception([
        frame('a', 'chrome-extension://abc/content.js', 1),
        frame('b', 'data:text/javascript,1', 1),
        frame('c', '', 1)
      ]),
      context,
      { isFile: files(), fetch }
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  describe('a virtual module', () => {
    const PAGE_FILE = 'src/pages/smoke.astro'
    const VIRTUAL = `${PAGE_FILE}?astro&type=script&index=0&lang.ts`
    /**
     * One bundle of three lines, and one map for it naming three sources: a file, a
     * virtual module named after a file, and a file with a dev server's cache-busting on
     * it. Line 1 is `smoke-lib.ts` 3:3, line 2 the page's script 26:5, line 3 `fresh.ts` 8:5.
     */
    const THREE = JSON.stringify({
      version: 3,
      sources: ['../../src/smoke-lib.ts', `../../${VIRTUAL}`, '../../src/fresh.ts?t=1712'],
      names: [],
      mappings: 'AAEE;ACuBE;AClBA'
    })
    const everyFile = files('src/smoke-lib.ts', PAGE_FILE, 'src/fresh.ts')
    const threeSources = (): FetchText =>
      network({
        [BUNDLE]: served(`a()\nb()\nc()\n//# sourceMappingURL=index-4f2a.js.map\n`),
        [MAP_URL]: served(THREE)
      })

    it('resolves the files in a map and not the virtual module beside them', async () => {
      const body = exception([
        frame('lib', BUNDLE, 1),
        frame('page', BUNDLE, 2),
        frame('', BUNDLE, 3)
      ])
      const resolved = await resolveEntry(body, context, {
        isFile: everyFile,
        fetch: threeSources()
      })
      expect(resolved.stack).toEqual([
        {
          function: 'lib',
          url: BUNDLE,
          line: 3,
          column: 3,
          resolution: 'resolved',
          path: 'src/smoke-lib.ts'
        },
        // The page's script: its lines are the extracted script's, not the page's.
        body.stack[1],
        {
          function: '',
          url: BUNDLE,
          line: 8,
          column: 5,
          resolution: 'resolved',
          path: 'src/fresh.ts'
        }
      ])
    })

    it('does not resolve a dev server script that is a virtual module, arithmetic or map', async () => {
      // As an Astro dev server serves a page's `<script>`: at the virtual module's URL, with
      // an inline map over the extracted script that names the virtual module again.
      const url = `http://localhost:5173/${VIRTUAL}`
      const identity = JSON.stringify({
        version: 3,
        sources: ['smoke.astro?astro&type=script&index=0&lang.ts'],
        names: [],
        mappings: 'AAAA;AACA'
      })
      const isFile = vi.fn(everyFile)
      const body = exception([frame('', url, 2)])
      const resolved = await resolveEntry(body, context, {
        isFile,
        fetch: network({
          [url]: served(
            `x()\ny()\n//# sourceMappingURL=data:application/json;base64,${btoa(identity)}\n`
          )
        })
      })
      expect(resolved).toEqual(body)
      // Decided from the name alone: it costs no read of the file it is named after.
      expect(isFile).not.toHaveBeenCalledWith(`${REPO}/${PAGE_FILE}`)
    })

    it('decides from the name, so it costs nothing against the deadline', async () => {
      vi.useFakeTimers()
      let settled = false
      const pending = resolveEntry(exception([frame('page', BUNDLE, 2)]), context, {
        isFile: everyFile,
        fetch: threeSources()
      }).then((resolved) => {
        settled = true
        return resolved
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect((await pending).stack[0]).toMatchObject({ resolution: 'failed', path: null })
    })
  })

  it('does not wait on a map that arrives after the timeout, and abandons it', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetch: FetchText = (url, aborted) => {
      if (url === BUNDLE) return Promise.resolve(bundled()[BUNDLE])
      signal = aborted
      return new Promise((resolve) =>
        setTimeout(() => resolve(bundled()[MAP_URL]), RESOLUTION_TIMEOUT_MS * 2)
      )
    }
    const body = { ...exception([]), location: at(BUNDLE, 1, thrownAt) }
    let settled = false
    const pending = resolveEntry(body, context, { isFile: files('src/checkout.js'), fetch }).then(
      (resolved) => {
        settled = true
        return resolved
      }
    )
    await vi.advanceTimersByTimeAsync(RESOLUTION_TIMEOUT_MS)
    expect(settled).toBe(true)
    expect(signal?.aborted).toBe(true)
    const resolved = await pending
    await vi.advanceTimersByTimeAsync(RESOLUTION_TIMEOUT_MS * 2)
    expect(resolved).toEqual(body)
  })
})
