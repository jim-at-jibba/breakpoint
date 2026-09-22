import { Button } from '@renderer/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@renderer/components/ui/command'
import { useCallback, useEffect, useRef, useState } from 'react'
import { projectListingLabel, type ProjectListing } from '../../../shared/project-listing'
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
 */
export function ProjectSwitcher({ project }: { project: Project | null }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectListing[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Bumped on every open and close, so a slow list cannot answer a later one. */
  const loadVersion = useRef(0)

  /** Opens the switcher and reads the directory again: the list is never held between opens. */
  const show = useCallback((): void => {
    setOpen(true)
    setMessage(null)
    setProjects(null)
    const version = (loadVersion.current += 1)

    void (async (): Promise<void> => {
      try {
        const response = await window.breakpoint.invoke('project.list')
        if (version !== loadVersion.current) return
        if (response.ok) {
          setProjects(response.data.projects)
          return
        }
        setProjects([])
        setMessage(response.error.message)
      } catch (error) {
        if (version !== loadVersion.current) return
        setProjects([])
        setMessage(errorMessage(error))
      }
    })()
  }, [])

  const hide = useCallback((): void => {
    setOpen(false)
    loadVersion.current += 1
  }, [])

  // The shortcut is the window's own, so it answers wherever the app's chrome has focus.
  // Opening an open switcher re-reads the list rather than closing it; Escape closes it.
  //
  // One modifier per platform, not either: Control-P is emacs' "previous line" in every
  // text field on macOS, and taking it there would cost the address bar a binding the
  // developer already has.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.shiftKey) return
      if (!(isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
      if (event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      show()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [show])

  async function choose(listing: ProjectListing): Promise<void> {
    if (!listing.openable) {
      setMessage(`${projectListingLabel(listing)} cannot be opened: ${listing.message}`)
      return
    }
    try {
      const response = await window.breakpoint.invoke('project.open', { path: listing.repoPath })
      if (!response.ok) {
        setMessage(`${listing.name} could not be opened: ${response.error.message}`)
        return
      }
      hide()
    } catch (error) {
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
        {project ? <span data-testid="project-name">{project.name}</span> : 'Projects'}
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
          placeholder="Switch project…"
          data-testid="project-search"
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
        {message !== null && (
          <span
            role="alert"
            data-testid="project-switcher-message"
            className="px-[var(--bp-space-3)] pb-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
          >
            {message}
          </span>
        )}
      </CommandDialog>
    </>
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
