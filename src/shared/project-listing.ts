import type { RefusalReason } from './project'

/**
 * The project list: what the switcher shows, and the rules for reading and ordering it.
 *
 * Separate from `project.ts` because that module reaches `node:crypto` and `node:path`
 * for the stored file's name, which the renderer cannot bundle. The list is the one part
 * of projects a window needs as code rather than as a type, so it lives here, where
 * nothing but the language is imported.
 *
 * Pure: the store in the main process reads the directory; this decides what the entries
 * say and what order they come in.
 */

/**
 * One project as the switcher lists it. The list is the project directory read — there
 * is no index to fall out of step with it — so an entry is a file: one that loads, or
 * one that refuses to and says why when it is chosen. A refusing file is listed rather
 * than dropped, because a project that has quietly vanished is a worse answer than one
 * that says it cannot be opened.
 */
export type ProjectListing = OpenableProject | UnopenableProject

export interface OpenableProject {
  /** The file's name in the project directory. What makes an entry unique. */
  file: string
  openable: true
  name: string
  /** What opening this entry passes to `project.open`: the project's identity. */
  repoPath: string
}

export interface UnopenableProject {
  file: string
  openable: false
  /**
   * Salvaged from the file even though the file as a whole is refused, so the entry is
   * listed as something a developer recognises. Null where even that was illegible, and
   * the entry is listed by its file name instead.
   */
  name: string | null
  repoPath: string | null
  reason: RefusalReason
  /** Why, in the words an open would have been refused with. */
  message: string
}

/**
 * The name and repo path read straight off a file that will not load as a project. Only
 * strings are taken and nothing else is checked: this labels an entry already known to
 * be unopenable, and is never a way to open one.
 */
export function salvageProjectIdentity(raw: unknown): {
  name: string | null
  repoPath: string | null
} {
  const project = asRecord(asRecord(raw)?.project)
  return {
    name: typeof project?.name === 'string' ? project.name : null,
    repoPath: typeof project?.repoPath === 'string' ? project.repoPath : null
  }
}

/** What an entry is listed as: its name, or its file name where no name was legible. */
export function projectListingLabel(listing: ProjectListing): string {
  return listing.name ?? listing.file
}

/**
 * The order the switcher lists projects in: by what each is labelled, whatever case it
 * was typed in, then by file so two projects of one name hold a stable order.
 */
export function compareProjectListings(a: ProjectListing, b: ProjectListing): number {
  const byLabel = projectListingLabel(a).localeCompare(projectListingLabel(b), undefined, {
    sensitivity: 'base'
  })
  return byLabel !== 0 ? byLabel : a.file.localeCompare(b.file)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
