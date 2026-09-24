import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { PANE_DIMENSION_RANGE } from './panes'
import {
  DEFAULT_PANE_PRESETS,
  DEFAULT_PRESETS,
  paneFromPreset,
  parseViewportProperties,
  presetById,
  type Preset,
  type ViewportProperties
} from './presets'
import { isWebUrl } from './urls'

/**
 * A project: a repo path, when it has one, plus everything Breakpoint remembers about
 * working on it. This
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
export interface Pane extends ViewportProperties {
  id: string
  name: string
  colorScheme: ColorScheme
  /** The id of the session this pane's cookies, cache and storage live in. */
  session: string
  preset: string | null
}

/**
 * What can change about a pane once it exists. Its id, its session and the preset it was
 * created from are not here: identity does not change, and the preset is a record of
 * where the pane came from rather than a value to be edited ([ADR-0011]).
 */
export type PaneChanges = Partial<
  Pick<Pane, 'width' | 'height' | 'dpr' | 'mobile' | 'touch' | 'colorScheme'>
>

export interface Session {
  id: string
  name: string
}

export interface Project {
  name: string
  /**
   * Absolute and canonical. The project's identity ([CONTEXT.md]). Null for a project
   * opened by typing a URL, which has no identity: it is never stored and lasts as long
   * as the window ([ADR-0015]).
   */
  repoPath: string | null
  /**
   * Where the project's panes are pointed: the URL it opens at, and the URL a navigation
   * leaves it on, so it reopens where it was left. Named for where a project starts
   * because that is what it is until something navigates.
   */
  startUrl: string
  /** The origins automation may navigate to. Never constrains the developer ([ADR-0013]). */
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

/**
 * A new project's three panes are resolved from the presets the caller holds, exactly as
 * a pane added later is: there is one path from a preset to a pane, and a new project
 * takes it three times. A default whose preset the user has deleted falls back to the
 * built-in one, so a new project is never short of the set PRD 6.2 V1 promises.
 */
export function createProject(
  repoPath: string,
  presets: readonly Preset[] = DEFAULT_PRESETS
): StoredProject {
  return { name: basename(repoPath), repoPath, ...projectAt(DEFAULT_START_URL, presets) }
}

/**
 * A project opened by typing a URL rather than from a repo ([ADR-0015]). The same shape
 * as any other, pointed where it was sent, and allowed that origin exactly as a repo
 * project is allowed the one it starts on. Named for the host it was opened on, because
 * there is nothing else to call it; the name is a label and never a way to find it.
 *
 * `url` must already be a web URL: the route expands and checks what was typed.
 */
export function createAdHocProject(
  url: string,
  presets: readonly Preset[] = DEFAULT_PRESETS
): Project {
  return { name: new URL(url).host, repoPath: null, ...projectAt(url, presets) }
}

function projectAt(url: string, presets: readonly Preset[]): Omit<Project, 'name' | 'repoPath'> {
  const panes = DEFAULT_PANE_PRESETS.map((id) => {
    const preset = presetById(presets, id) ?? presetById(DEFAULT_PRESETS, id)!
    return { ...paneFromPreset(preset), id: newPaneId(), session: DEFAULT_SESSION.id }
  })
  return {
    startUrl: url,
    allowedOrigins: [new URL(url).origin],
    panes,
    layout: 'horizontal',
    zoom: 'fit',
    focusedPane: null,
    sessions: [DEFAULT_SESSION]
  }
}

/** One place a pane's identity is minted, whether it arrives with a project or later. */
export function newPaneId(): string {
  return globalThis.crypto.randomUUID()
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
export const PROJECT_FILE_VERSION = 3

export interface ProjectFile {
  version: number
  project: StoredProject
}

/** What the store holds: only a project with a repo path is ever written ([ADR-0015]). */
export type StoredProject = Project & { repoPath: string }

/** Whether a project has an identity, and so a place in the store. */
export function isStoredProject(project: Project): project is StoredProject {
  return project.repoPath !== null
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

/**
 * Version 2 panes had neither `touch` nor `userAgent`: touch followed the mobile flag,
 * and the user agent was always Breakpoint's own. Both are written down as they were in
 * force, so a project opened after the upgrade renders exactly as it did before it (#12).
 *
 * Version 2 also took any positive size, where a pane is now whole pixels inside
 * `PANE_DIMENSION_RANGE`. A dimension outside that is brought into it here rather than
 * refusing the file: a tightened rule is what a migration is for, and a project that will
 * not open is a worse answer than a pane a pixel from where it was.
 */
function addViewportProperties(file: Record<string, unknown>): Record<string, unknown> {
  const project = file.project
  if (typeof project !== 'object' || project === null || Array.isArray(project)) return file
  const panes = (project as { panes?: unknown }).panes
  if (!Array.isArray(panes)) return file
  return {
    ...file,
    project: {
      ...project,
      panes: panes.map((pane: unknown) => {
        if (typeof pane !== 'object' || pane === null) return pane
        const { mobile, width, height } = pane as Record<string, unknown>
        return {
          ...pane,
          width: asPaneDimension(width),
          height: asPaneDimension(height),
          touch: mobile === true,
          userAgent: null
        }
      })
    }
  }
}

/** Left alone if it is not a number at all: that is corruption, not an old rule. */
function asPaneDimension(value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const { min, max } = PANE_DIMENSION_RANGE
  return Math.min(Math.max(Math.round(value), min), max)
}

export const PROJECT_MIGRATIONS: ProjectMigrations = {
  1: addFocusedPane,
  2: addViewportProperties
}

/** Why a file on disk is refused. Reported to the caller as `details.reason`. */
export type RefusalReason = 'newer' | 'corrupt'

export type ReadProjectResult =
  { ok: true; project: StoredProject } | { ok: false; reason: RefusalReason; message: string }

interface ReadProjectOptions {
  version: number
  migrations: ProjectMigrations
}

export function writeProjectFile(project: StoredProject): ProjectFile {
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
  if (!isColorScheme(pane.colorScheme)) return undefined
  if (!isString(pane.session) || !sessionIds.has(pane.session)) return undefined
  if (pane.preset !== null && !isString(pane.preset)) return undefined
  const properties = parseViewportProperties(pane)
  if (!properties) return undefined
  return {
    id: pane.id,
    name: pane.name,
    colorScheme: pane.colorScheme,
    session: pane.session,
    preset: pane.preset,
    ...properties
  }
}

/**
 * Every field checked, and only the known fields copied out, so the result is exactly a
 * `Project`. A stored project always has a repo path — nothing without one is written —
 * so a file that says null is not a project this store could have written.
 */
export function parseProject(value: unknown): StoredProject | undefined {
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
