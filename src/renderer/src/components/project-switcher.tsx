import { Button } from '@renderer/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList
} from '@renderer/components/ui/command'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  projectListingLabel,
  repoPathParent,
  type ProjectListing
} from '../../../shared/project-listing'
import type { Project } from '../../../shared/project'

/**
 * The project switcher: every project Breakpoint has stored, on ⌘P (PRD J3).
 *
 * The list is read each time the switcher opens rather than held, because the project
 * directory *is* the list — there is no index — so a project another window created is
 * in it and one whose file has gone is not.
 *
 * Choosing a project opens it, which swaps the pane set, layout, zoom and URL to that
 * project's stored state without a restart. It is the route `breakpoint .` reaches, so
 * switching from here and switching from a terminal are one code path ([ADR-0005]).
 *
 * A project whose file refuses to load is listed with the rest and reports why when it
 * is chosen. It is never offered as openable: the store has already read that file and
 * been refused, and asking again would only be refused the same way.
 *
 * This is the one surface drawn over the canvas rather than on the app's own rim. It is
 * not a pane-state event, which is what AGENTS.md keeps off a page — it is the developer
 * asking to leave this project, and nothing in the panes behind it is the subject.
 *
 * Whether it is showing is snapshot state, not this component's ([ADR-0016]). The chord
 * that opens it is an application menu accelerator, which fires in the main process —
 * a `keydown` listener here is deaf whenever a pane has focus, which is nearly always
 * (#38). So the button, Escape and the accelerator all cause one route, and this draws
 * what the snapshot says.
 */
export function ProjectSwitcher({
  project,
  open
}: {
  project: Project | null
  /** From the snapshot: `app.setSwitcher` is the only thing that changes it. */
  open: boolean
}): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectListing[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Bumped on every interaction, so old list and selection results cannot affect a later one. */
  const interactionVersion = useRef(0)

  /** Asks for the switcher to be shown or hidden. What is drawn follows from the snapshot. */
  const ask = useCallback((next: boolean): void => {
    void (async (): Promise<void> => {
      try {
        const response = await window.breakpoint.invoke('app.setSwitcher', { open: next })
        if (!response.ok) setMessage(response.error.message)
      } catch (error) {
        setMessage(errorMessage(error))
      }
    })()
  }, [])

  const show = useCallback((): void => ask(true), [ask])
  const hide = useCallback((): void => ask(false), [ask])

  // What was read last time is forgotten the moment the switcher opens or closes, in
  // render rather than in an effect: an effect would draw the previous open's list for a
  // frame first, and that list is exactly the one that may no longer be true.
  const [showing, setShowing] = useState(open)
  if (showing !== open) {
    setShowing(open)
    setProjects(null)
    setMessage(null)
  }

  // The directory is read each time the switcher opens, and never held between opens: a
  // project another window created is in the list and one whose file has gone is not.
  // Keyed on the snapshot's `open`, so the accelerator's open and the button's open read
  // it the same way.
  useEffect(() => {
    const version = (interactionVersion.current += 1)
    if (!open) return

    void (async (): Promise<void> => {
      try {
        const response = await window.breakpoint.invoke('project.list')
        if (version !== interactionVersion.current) return
        if (response.ok) {
          setProjects(response.data.projects)
          return
        }
        setProjects([])
        setMessage(response.error.message)
      } catch (error) {
        if (version !== interactionVersion.current) return
        setProjects([])
        setMessage(errorMessage(error))
      }
    })()
  }, [open])

  async function choose(listing: ProjectListing): Promise<void> {
    const version = (interactionVersion.current += 1)
    if (!listing.openable) {
      setMessage(`${projectListingLabel(listing)} cannot be opened: ${listing.message}`)
      return
    }
    try {
      const response = await window.breakpoint.invoke('project.open', { path: listing.repoPath })
      if (version !== interactionVersion.current) return
      if (!response.ok) {
        setMessage(`${listing.name} could not be opened: ${response.error.message}`)
        return
      }
      hide()
    } catch (error) {
      if (version !== interactionVersion.current) return
      setMessage(errorMessage(error))
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title={`Switch project (${SHORTCUT})`}
        data-testid="project-switcher"
        onClick={show}
      >
        {/* The open project names the button. With nothing open there is no project to
            name, and the button says what it is instead. */}
        {project ? <OpenProjectLabel project={project} /> : 'Projects'}
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={(next: boolean) => (next ? show() : hide())}
        title="Switch project"
        description="Every project Breakpoint has stored"
        className="w-[var(--bp-switcher-w)] sm:max-w-[var(--bp-switcher-w)]"
      >
        {/* A message is about the entry that was chosen, so typing past it clears it. */}
        <CommandInput
          placeholder="Search projects…"
          data-testid="project-search"
          hint={SHORTCUT}
          onValueChange={() => setMessage(null)}
        />
        <CommandList data-testid="project-list">
          <CommandEmpty>
            {projects === null ? 'Reading projects…' : 'No project of that name.'}
          </CommandEmpty>
          {(projects ?? []).map((listing) => (
            <ProjectOption
              key={listing.file}
              listing={listing}
              current={listing.openable && listing.repoPath === project?.repoPath}
              onChoose={choose}
            />
          ))}
        </CommandList>
        {/* A band of its own above the footer, so a long refusal wraps inside the
            surface instead of stretching it. */}
        {message !== null && (
          <span
            role="alert"
            data-testid="project-switcher-message"
            className="flex-none border-t border-[color:var(--bp-border)] px-[var(--bp-space-4)] py-[var(--bp-space-3)] text-[length:var(--bp-text-base)] text-[color:var(--bp-error)]"
          >
            {message}
          </span>
        )}
        <CommandFooter>
          <span>↵ open</span>
          <span>↑↓ navigate</span>
          <span className="ml-auto">esc close</span>
        </CommandFooter>
      </CommandDialog>
    </>
  )
}

/**
 * The open project as the toolbar names it: which checkout it came from, and not only its
 * name. The name is the directory's, which under git worktrees is the worktree and not
 * the repo, so the segment above is drawn before it, quieter, with the whole path to
 * hover (#31). A project with no repo path says so instead: it is named for the host it
 * was opened on, and quitting loses it ([ADR-0015]).
 */
function OpenProjectLabel({ project }: { project: Project }): React.JSX.Element {
  const name = <span data-testid="project-name">{project.name}</span>
  if (project.repoPath === null) {
    return (
      <span className="flex min-w-0 items-baseline gap-[var(--bp-space-2)]">
        {name}
        <span data-testid="project-unsaved" className="text-[color:var(--bp-ink-faint)]">
          not saved
        </span>
      </span>
    )
  }
  const parent = repoPathParent(project.repoPath)
  return (
    <span className="flex min-w-0" title={project.repoPath} data-testid="project-checkout">
      {parent !== null && <span className="text-[color:var(--bp-ink-faint)]">{parent}</span>}
      {name}
    </span>
  )
}

/**
 * One row: the repo path's last two segments, with the whole path to hover. The segment
 * above the directory is what tells two worktrees of one repo apart (#19), and the rest
 * of the path is there for the case it does not.
 */
function ProjectOption({
  listing,
  current,
  onChoose
}: {
  listing: ProjectListing
  /** Whether this is the project already open, which is not a reason to leave it out. */
  current: boolean
  onChoose(listing: ProjectListing): Promise<void>
}): React.JSX.Element {
  const label = projectListingLabel(listing)
  // The repo path where there is one; the file is all an entry that lost its path has.
  const identity = listing.repoPath ?? listing.file
  return (
    <CommandItem
      value={`${label} ${identity}`}
      title={identity}
      data-testid="project-option"
      data-project={identity}
      data-openable={listing.openable}
      onSelect={() => void onChoose(listing)}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!listing.openable && (
        <span className="flex-none text-[length:var(--bp-text-sm)] text-[color:var(--bp-warn)]">
          Unopenable
        </span>
      )}
      {current && (
        <span className="flex-none text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
          Open
        </span>
      )}
    </CommandItem>
  )
}

/** The platform the window is drawn on, which is the only thing the shortcut needs from it. */
function isMac(): boolean {
  return window.electron.process.platform === 'darwin'
}

const SHORTCUT = isMac() ? '\u2318P' : 'Ctrl+P'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
