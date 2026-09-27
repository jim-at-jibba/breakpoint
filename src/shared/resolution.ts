import type { ConsoleEntryBody, SourceLocation } from './event-log'

/**
 * Resolution: turning a stack frame's URL, line and column into a path inside the
 * project's repo, before the entry is appended ([ADR-0020]). A source map is a live
 * artifact, and the agent loop reads after an edit — exactly when the dev server has
 * rebuilt and the map that explained the error is gone — so a location is made as true
 * as it can be on arrival and then frozen with the entry.
 *
 * Discovery here is arithmetic. A dev server asked for `/src/App.tsx` has already said
 * where the file is, so a script URL on the page's own origin whose path names a file in
 * the repo resolves to it, at the line and column it was reported at. Anything else keeps
 * the location it came with, flagged: an ordinary outcome, never an error.
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

/**
 * The repo-relative path a script URL was asked for, or `null` when it names none: another
 * origin, which is not the dev server; a path that is not a file's; or one that could
 * leave the repo once its escapes are read.
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
  let path: string
  try {
    path = decodeURIComponent(script.pathname)
  } catch {
    return null
  }
  const segments = path.split('/').slice(1)
  const unsafe = segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\0')
  )
  return segments.length === 0 || unsafe ? null : segments.join('/')
}

/**
 * The entry with its location and every frame of its stack resolved where they can be.
 * Each script is asked about once, and each location resolves or fails on its own, so a
 * slow one costs only itself.
 */
export async function resolveEntry<T extends ConsoleEntryBody>(
  body: T,
  { repoPath, page }: ResolutionContext,
  isFile: IsFile
): Promise<T> {
  if (repoPath === null) return body
  const root = repoPath.replace(/[/\\]+$/, '')
  const lookups = new Map<string, Promise<string | null>>()
  let expire = (): void => {}
  const deadline = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), RESOLUTION_TIMEOUT_MS)
    expire = () => {
      clearTimeout(timer)
      resolve(null)
    }
  })
  const lookUp = (url: string): Promise<string | null> => {
    let pending = lookups.get(url)
    if (!pending) {
      const path = repoPathFor(url, page)
      pending =
        path === null
          ? Promise.resolve(null)
          : Promise.race([
              isFile(`${root}/${path}`).then(
                (exists) => (exists ? path : null),
                () => null
              ),
              deadline
            ])
      lookups.set(url, pending)
    }
    return pending
  }
  const resolveLocation = async <L extends SourceLocation>(location: L): Promise<L> => {
    const path = await lookUp(location.url)
    return path === null ? location : { ...location, resolution: 'resolved', path }
  }
  try {
    const [location, stack] = await Promise.all([
      body.location ? resolveLocation(body.location) : null,
      Promise.all(body.stack.map(resolveLocation))
    ])
    return { ...body, location, stack }
  } finally {
    expire()
  }
}
