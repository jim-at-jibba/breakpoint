import { AnyMap, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping'
import type { ConsoleEntryBody, SourceLocation } from './event-log'

/**
 * Resolution: turning a stack frame's URL, line and column into a path inside the
 * project's repo, before the entry is appended ([ADR-0020]). A source map is a live
 * artifact, and the agent loop reads after an edit — exactly when the dev server has
 * rebuilt and the map that explained the error is gone — so a location is made as true
 * as it can be on arrival and then frozen with the entry.
 *
 * Discovery is arithmetic first. A dev server asked for `/src/App.tsx` has already said
 * where the file is, so a script URL on the page's own origin whose path names a file in
 * the repo resolves to it, at the line and column it was reported at. Only where that
 * names no file — a production-style bundle — is the script fetched and its source map
 * followed to the file and position it was built from. Anything else keeps the location
 * it came with, flagged: an ordinary outcome, never an error.
 *
 * Bounded by `RESOLUTION_TIMEOUT_MS`. A late entry is worse than an unresolved one, since
 * the console's ordering and the cursor's meaning both depend on entries arriving when
 * they happened, so whatever has not resolved by then stays as it was reported.
 */

/** How long an entry may wait on resolution before it is appended as reported. */
export const RESOLUTION_TIMEOUT_MS = 500

export interface ResolutionContext {
  /** The open project's repo, or `null` for a repo-less one, which resolves nothing. */
  repoPath: string | null
  /** The page the pane was showing when it heard the entry: the dev server's origin. */
  page: string
}

/** Whether an absolute path names a file. Supplied by main, which has the disk. */
export type IsFile = (absolute: string) => Promise<boolean>

/** A successful response: its body, and its headers by case-insensitive name. */
export interface Fetched {
  text: string
  header(name: string): string | null
}

/**
 * Fetches a script or a map, or `null` for anything but a successful response. Supplied
 * by main, which fetches as the pane would. `signal` aborts once the entry stops waiting.
 */
export type FetchText = (url: string, signal: AbortSignal) => Promise<Fetched | null>

/** What resolution asks of the world outside the entry. */
export interface ResolutionIO {
  isFile: IsFile
  fetch: FetchText
}

/**
 * The query keys a dev server adds to bust caches, which leave a file and its lines as they
 * are: Vite's `t`, an HMR timestamp, and `v`, a dependency's build hash.
 */
const CACHE_BUSTING = new Set(['t', 'v'])

/**
 * Whether a URL's query leaves it naming the file its path names. Any query but
 * cache-busting names a virtual module: `Page.astro?astro&type=script&index=0&lang.ts` is
 * a script extracted from the page, and its lines are the script's, not the page's. Vue
 * and Svelte write the same shape. Known keys are listed rather than virtual ones, so a
 * query nobody anticipated fails honestly instead of resolving to the wrong line.
 */
function namesFile(query: string): boolean {
  return [...new URLSearchParams(query).keys()].every((key) => CACHE_BUSTING.has(key))
}

/**
 * The repo-relative path a script URL was asked for, or `null` when it names none: another
 * origin, which is not the dev server; a virtual module; a path that is not a file's; or
 * one that could leave the repo once its escapes are read.
 */
export function repoPathFor(url: string, page: string): string | null {
  let script: URL
  let origin: string
  try {
    script = new URL(url)
    origin = new URL(page).origin
  } catch {
    return null
  }
  if (script.protocol !== 'http:' && script.protocol !== 'https:') return null
  if (script.origin !== origin) return null
  if (!namesFile(script.search)) return null
  let path: string
  try {
    path = decodeURIComponent(script.pathname)
  } catch {
    return null
  }
  return path.startsWith('/') ? relative(path.slice(1)) : null
}

/** The path as it stands, if every segment of it stays inside whatever it is relative to. */
function relative(path: string): string | null {
  const segments = path.split('/')
  const unsafe = segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\0')
  )
  return unsafe ? null : path
}

/** Where a location resolved to: a repo-relative path, and a position in that file. */
interface Resolved {
  path: string
  line: number
  column: number
}

/** A script's answer for any position in it, once it is known how to ask. */
type Script = (line: number, column: number) => Promise<Resolved | null>

/** A source map, and the URL its relative sources are read against. */
interface Followed {
  map: TraceMap
  base: string
}

/**
 * The entry with its location and every frame of its stack resolved where they can be.
 * Each script is asked about once, and each location resolves or fails on its own, so a
 * slow one costs only itself. Whatever is still being fetched when the entry stops
 * waiting is aborted: a map that arrives late changes nothing.
 */
export async function resolveEntry<T extends ConsoleEntryBody>(
  body: T,
  { repoPath, page }: ResolutionContext,
  io: ResolutionIO
): Promise<T> {
  if (repoPath === null) return body
  const root = repoPath.replace(/[/\\]+$/, '')
  const fetches = new AbortController()
  let expire = (): void => {}
  const deadline = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), RESOLUTION_TIMEOUT_MS)
    expire = () => {
      clearTimeout(timer)
      resolve(null)
    }
  })
  const isFile = once((path: string) => io.isFile(`${root}/${path}`).catch(() => false))
  const inRepo = async (source: string, base: string): Promise<string | null> => {
    for (const path of sourcePaths(source, base, root)) if (await isFile(path)) return path
    return null
  }
  const scriptAt = once(async (url: string): Promise<Script | null> => {
    const path = repoPathFor(url, page)
    if (path !== null && (await isFile(path))) {
      return (line, column) => Promise.resolve({ path, line, column })
    }
    const followed = await followMap(url, io.fetch, fetches.signal)
    return followed && ((line, column) => positionIn(followed, line, column, inRepo))
  })
  const resolveLocation = async <L extends SourceLocation>(location: L): Promise<L> => {
    const found = await Promise.race([
      scriptAt(location.url).then(
        (script) => script?.(location.line, location.column) ?? null,
        () => null
      ),
      deadline
    ])
    return found === null ? location : { ...location, resolution: 'resolved', ...found }
  }
  try {
    const [location, stack] = await Promise.all([
      body.location ? resolveLocation(body.location) : null,
      Promise.all(body.stack.map(resolveLocation))
    ])
    return { ...body, location, stack }
  } finally {
    expire()
    fetches.abort()
  }
}

/** `ask`, asked once per key: every later call with that key shares the first answer. */
function once<T>(ask: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const answers = new Map<string, Promise<T>>()
  return (key) => {
    let answer = answers.get(key)
    if (!answer) {
      answer = ask(key)
      answers.set(key, answer)
    }
    return answer
  }
}

/**
 * The source map a script names, fetched, or `null` when it names none or the map cannot
 * be had: a `SourceMap` header, or the script's last `sourceMappingURL` comment, which may
 * be the map itself as a `data:` URL.
 */
async function followMap(
  url: string,
  fetchText: FetchText,
  signal: AbortSignal
): Promise<Followed | null> {
  if (!isWeb(url)) return null
  try {
    const script = await fetchText(url, signal)
    if (!script) return null
    const named =
      script.header('sourcemap') ?? script.header('x-sourcemap') ?? mapComment(script.text)
    if (named === null) return null
    const mapUrl = new URL(named, url)
    if (mapUrl.protocol === 'data:') {
      // Inline, a map's sources are relative to the script that carries it.
      return { map: new AnyMap(dataText(mapUrl.href)), base: url }
    }
    if (!isWeb(mapUrl.href)) return null
    const map = await fetchText(mapUrl.href, signal)
    return map && { map: new AnyMap(map.text), base: mapUrl.href }
  } catch {
    return null
  }
}

function isWeb(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/** The URL in a script's last `//# sourceMappingURL=` or `/*# sourceMappingURL= *\/`. */
function mapComment(text: string): string | null {
  let found: string | null = null
  for (const match of text.matchAll(/\/[/*][#@]\s*sourceMappingURL=([^\s'"*]+)/g)) {
    found = match[1]
  }
  return found
}

/** A `data:` URL's payload as text. Throws on one that does not decode. */
function dataText(href: string): string {
  const comma = href.indexOf(',')
  if (comma === -1) throw new Error('A data: URL without a payload')
  const payload = href.slice(comma + 1)
  if (!/;base64$/i.test(href.slice(0, comma))) return decodeURIComponent(payload)
  const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Where a position in a bundle came from, if the map says and its source is in the repo. */
async function positionIn(
  { map, base }: Followed,
  line: number,
  column: number,
  inRepo: (source: string, base: string) => Promise<string | null>
): Promise<Resolved | null> {
  const original = originalPositionFor(map, { line, column: Math.max(0, column - 1) })
  if (original.source === null) return null
  const written = map.sources[map.resolvedSources.indexOf(original.source)]
  if (written === null || written === undefined) return null
  const { sourceRoot } = map
  const rooted = sourceRoot && !SCHEME.test(written) && !written.startsWith('/')
  const path = await inRepo(rooted ? `${sourceRoot.replace(/\/?$/, '/')}${written}` : written, base)
  return path === null ? null : { path, line: original.line, column: original.column + 1 }
}

const SCHEME = /^([a-z][a-z\d+.-]*):\/\/([^/]*)(.*)$/i

/**
 * The repo-relative paths a map's source could be naming, most specific first. A bundler
 * writes a source however it likes, so each way of reading one is tried:
 *
 * - an absolute path on the machine that built it, or a `file:` URL: only inside the repo.
 * - `webpack://app/./src/…` and its kind: the path after the name, from the repo's root.
 * - relative: against the map's URL, as the browser's own devtools read it, and then as
 *   written, for a bundler that writes sources relative to the project.
 *
 * A reading that climbs out of where it starts names nothing, rather than a repo file that
 * happens to share its tail, and so does a virtual module, rather than the file it is
 * named after.
 */
function sourcePaths(written: string, base: string, root: string): string[] {
  const query = written.indexOf('?')
  if (query !== -1 && !namesFile(written.slice(query))) return []
  const source = query === -1 ? written : written.slice(0, query)
  const home = `${root.replace(/\\/g, '/')}/`
  const scheme = SCHEME.exec(source)
  const paths: (string | null)[] = []
  if (scheme?.[1].toLowerCase() === 'file' || (!scheme && source.startsWith('/'))) {
    const absolute = walk(scheme ? scheme[3] : source)
    const path = absolute && `/${absolute}`
    paths.push(path?.startsWith(home) ? path.slice(home.length) : null)
  } else if (scheme) {
    paths.push(walk(scheme[3]))
  } else {
    try {
      paths.push(walk(new URL(source, base).pathname))
    } catch {
      // A base that is not a URL leaves only the source as written.
    }
    paths.push(walk(source))
  }
  return [...new Set(paths.filter((path) => path !== null))]
}

/**
 * A path with its escapes read and its `.` and `..` segments applied, relative to where it
 * starts, or `null` if it climbs above that or names nothing.
 */
function walk(path: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  const segments: string[] = []
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment.includes('\0')) return null
    if (segment === '..') {
      if (segments.pop() === undefined) return null
    } else {
      segments.push(segment)
    }
  }
  return segments.length === 0 ? null : segments.join('/')
}
