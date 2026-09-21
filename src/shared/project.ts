import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { isWebUrl } from './urls'

/**
 * A project: a repo path plus everything Breakpoint remembers about working on it. This
 * is the shape that is stored, the shape the route table returns, and the shape the
 * renderer projects — one type, so the three can never disagree about a field.
 *
 * Pure: no file system here. The store in the main process reads and writes files; this
 * module decides what a valid one says.
 */

export type Layout = 'horizontal' | 'focus'

/** A percentage between 25 and 100, or Fit, which is a zoom value ([ADR-0009]). */
export type Zoom = number | 'fit'

export type ColorScheme = 'light' | 'dark' | 'system'

/** A pane stores its own resolved values; the preset is remembered for display only ([ADR-0011]). */
export interface Pane {
  id: string
  name: string
  width: number
  height: number
  dpr: number
  mobile: boolean
  colorScheme: ColorScheme
  /** The id of the session this pane's cookies, cache and storage live in. */
  session: string
  preset: string | null
}

export interface Session {
  id: string
  name: string
}

export interface Project {
  name: string
  /** Absolute and canonical. The project's identity ([CONTEXT.md]). */
  repoPath: string
  startUrl: string
  allowedOrigins: string[]
  panes: Pane[]
  layout: Layout
  zoom: Zoom
  /**
   * The pane Focus draws at 100%, or null for whichever is first. Stored, so a project
   * reopens on the pane it was left on, and named by id so nothing else has to be.
   */
  focusedPane: string | null
  sessions: Session[]
}

const DEFAULT_START_URL = 'http://localhost:3000'
const DEFAULT_SESSION: Session = { id: 'default', name: 'Default' }

/** PRD 6.2 V1: the pane set a project is useful with before anything is configured. */
const DEFAULT_PANES: ReadonlyArray<Omit<Pane, 'id' | 'session'>> = [
  {
    name: 'Mobile',
    width: 390,
    height: 844,
    dpr: 3,
    mobile: true,
    colorScheme: 'system',
    preset: 'mobile'
  },
  {
    name: 'Tablet',
    width: 820,
    height: 1180,
    dpr: 2,
    mobile: true,
    colorScheme: 'system',
    preset: 'tablet'
  },
  {
    name: 'Desktop',
    width: 1440,
    height: 900,
    dpr: 1,
    mobile: false,
    colorScheme: 'system',
    preset: 'desktop'
  }
]

export function createProject(repoPath: string): Project {
  return {
    name: basename(repoPath),
    repoPath,
    startUrl: DEFAULT_START_URL,
    allowedOrigins: [new URL(DEFAULT_START_URL).origin],
    panes: DEFAULT_PANES.map((pane) => ({
      ...pane,
      id: globalThis.crypto.randomUUID(),
      session: DEFAULT_SESSION.id
    })),
    layout: 'horizontal',
    zoom: 'fit',
    focusedPane: null,
    sessions: [DEFAULT_SESSION]
  }
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

/**
 * Bumped whenever the stored shape changes, with a migration added to `PROJECT_MIGRATIONS`
 * for the step. A file with a higher version than this refuses to load: guessing at fields
 * a later build added, and then saving over them, is how a downgrade quietly corrupts a
 * project.
 */
export const PROJECT_FILE_VERSION = 2

export interface ProjectFile {
  version: number
  project: Project
}

/** One step: takes a file at version `n` and returns it at `n + 1`. */
export type ProjectMigration = (file: Record<string, unknown>) => Record<string, unknown>

export type ProjectMigrations = Readonly<Record<number, ProjectMigration>>

/**
 * Version 2 added `focusedPane`. A version 1 project named no focused pane, and null is
 * what that means: Focus shows the first pane until one is chosen.
 */
const addFocusedPane: ProjectMigration = (file) => {
  const project = asRecord(file.project)
  if (!project) return file
  return { ...file, project: { focusedPane: null, ...project } }
}

export const PROJECT_MIGRATIONS: ProjectMigrations = { 1: addFocusedPane }

/** Why a file on disk is refused. Reported to the caller as `details.reason`. */
export type RefusalReason = 'newer' | 'corrupt'

export type ReadProjectResult =
  { ok: true; project: Project } | { ok: false; reason: RefusalReason; message: string }

interface ReadProjectOptions {
  version: number
  migrations: ProjectMigrations
}

export function writeProjectFile(project: Project): ProjectFile {
  return { version: PROJECT_FILE_VERSION, project }
}

/**
 * The file's name is a hash of the repo path, so no path character ever reaches the
 * file system and the directory is the index: the project list is the files in it.
 */
export function projectFileName(repoPath: string): string {
  return `${createHash('sha256').update(repoPath).digest('hex').slice(0, 32)}.json`
}

export function readProjectFile(
  raw: unknown,
  { version, migrations }: ReadProjectOptions = {
    version: PROJECT_FILE_VERSION,
    migrations: PROJECT_MIGRATIONS
  }
): ReadProjectResult {
  let file = asRecord(raw)
  if (!file) return corrupt('the file is not a JSON object')
  if (!Number.isInteger(file.version)) return corrupt('the file has no integer version')

  let fileVersion = file.version as number
  if (fileVersion > version) {
    return {
      ok: false,
      reason: 'newer',
      message: `written by a newer Breakpoint (file version ${fileVersion}, this build reads ${version})`
    }
  }

  while (fileVersion < version) {
    const step = migrations[fileVersion]
    if (!step) return corrupt(`no migration from file version ${fileVersion}`)
    file = step(file)
    fileVersion += 1
  }

  const project = parseProject(file.project)
  if (!project) return corrupt('the project inside the file is not a project')
  return { ok: true, project }
}

function corrupt(message: string): ReadProjectResult {
  return { ok: false, reason: 'corrupt', message }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const LAYOUTS: ReadonlySet<string> = new Set<Layout>(['horizontal', 'focus'])
const COLOR_SCHEMES: ReadonlySet<string> = new Set<ColorScheme>(['light', 'dark', 'system'])

export function isLayout(value: unknown): value is Layout {
  return typeof value === 'string' && LAYOUTS.has(value)
}

export function isColorScheme(value: unknown): value is ColorScheme {
  return typeof value === 'string' && COLOR_SCHEMES.has(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseZoom(value: unknown): Zoom | undefined {
  if (value === 'fit') return value
  if (typeof value === 'number' && value >= 25 && value <= 100) return value
  return undefined
}

function parseSession(value: unknown): Session | undefined {
  const session = asRecord(value)
  if (!session || !isString(session.id) || !isString(session.name)) return undefined
  return { id: session.id, name: session.name }
}

function parsePane(value: unknown, sessionIds: ReadonlySet<string>): Pane | undefined {
  const pane = asRecord(value)
  if (!pane) return undefined
  if (!isString(pane.id) || !isString(pane.name)) return undefined
  if (!isPositive(pane.width) || !isPositive(pane.height) || !isPositive(pane.dpr)) return undefined
  if (typeof pane.mobile !== 'boolean') return undefined
  if (!isColorScheme(pane.colorScheme)) return undefined
  if (!isString(pane.session) || !sessionIds.has(pane.session)) return undefined
  if (pane.preset !== null && !isString(pane.preset)) return undefined
  return {
    id: pane.id,
    name: pane.name,
    width: pane.width,
    height: pane.height,
    dpr: pane.dpr,
    mobile: pane.mobile,
    colorScheme: pane.colorScheme,
    session: pane.session,
    preset: pane.preset
  }
}

/** Every field checked, and only the known fields copied out, so the result is exactly a `Project`. */
export function parseProject(value: unknown): Project | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  if (!isString(raw.name) || !isString(raw.repoPath) || !isWebUrl(raw.startUrl)) return undefined
  if (!isStringArray(raw.allowedOrigins)) return undefined
  if (!isLayout(raw.layout)) return undefined
  const zoom = parseZoom(raw.zoom)
  if (zoom === undefined) return undefined

  if (!Array.isArray(raw.sessions)) return undefined
  const sessions: Session[] = []
  for (const entry of raw.sessions) {
    const session = parseSession(entry)
    if (!session) return undefined
    sessions.push(session)
  }
  const sessionIds = new Set(sessions.map((session) => session.id))

  if (!Array.isArray(raw.panes)) return undefined
  const panes: Pane[] = []
  for (const entry of raw.panes) {
    const pane = parsePane(entry, sessionIds)
    if (!pane) return undefined
    panes.push(pane)
  }

  // A focused pane naming a pane that has gone reads as null, which is what the field
  // already means elsewhere: Focus shows the first pane. Losing which pane was focused is
  // not a reason to refuse the project.
  const { focusedPane } = raw
  if (focusedPane !== null && !isString(focusedPane)) return undefined
  const focused = panes.some((pane) => pane.id === focusedPane) ? focusedPane : null

  return {
    name: raw.name,
    repoPath: raw.repoPath,
    startUrl: raw.startUrl,
    allowedOrigins: [...raw.allowedOrigins],
    panes,
    layout: raw.layout,
    zoom,
    focusedPane: focused,
    sessions
  }
}
