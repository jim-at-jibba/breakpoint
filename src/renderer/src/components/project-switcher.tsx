import { Button } from '@renderer/components/ui/button'
import {
  Command,
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
 */
export function ProjectSwitcher({ project }: { project: Project | null }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectListing[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Bumped on every open and close, so a slow list cannot answer a later one. */
  const loadVersion = useRef(0)

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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.shiftKey) return
      if (!(event.metaKey || event.ctrlKey)) return
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
        title="Switch project (⌘P)"
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
        className="w-[var(--bp-palette-w)] sm:max-w-[var(--bp-palette-w)]"
      >
        {/* The generated `CommandDialog` opens no `Command` of its own, so the root that
            every part below needs is supplied here rather than edited into CLI output. */}
        <Command>
          <CommandInput placeholder="Switch project…" data-testid="project-search" />
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
        </Command>
      </CommandDialog>
    </>
  )
}

/**
 * One row. What it is searched by is its label and its repo path together, because a
 * developer with two repos of one name tells them apart by where they are.
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
  return (
    <CommandItem
      value={`${label} ${listing.repoPath ?? listing.file}`}
      data-testid="project-option"
      data-project={listing.repoPath ?? listing.file}
      data-openable={listing.openable}
      onSelect={() => void onChoose(listing)}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {listing.openable ? (
        <span className="min-w-0 flex-none truncate font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
          {current ? 'Open' : listing.repoPath}
        </span>
      ) : (
        <span className="flex-none text-[length:var(--bp-text-sm)] text-[color:var(--bp-warn)]">
          Unopenable
        </span>
      )}
    </CommandItem>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
