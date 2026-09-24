import { useState } from 'react'
import type { Project } from '../../../shared/project'
import { expandUrl } from '../../../shared/urls'

/**
 * The one address bar. What is typed here points every pane at the same URL, so a
 * developer navigates once (PRD N1).
 *
 * The field shows where the project points until it is edited, so a navigation from
 * anywhere — `breakpoint open`, another window — is simply what it says next. Enter
 * navigates even when the text has not changed: a pane may have followed a link inside
 * itself since, and asking for the URL that is already shown is how it is brought back.
 *
 * Nothing typed here is ever refused for being outside the project's allowed origins.
 * That list binds automation and not the developer ([ADR-0013]); this field's only rule
 * is that the result has to be a page a pane can render.
 *
 * With nothing open it is the way in: a URL typed here opens a project with no repo path,
 * pointed at it ([ADR-0015]). That is the same route as any other navigation, which opens
 * the project rather than refusing when there is none, so this field does not know
 * which of the two it is asking for.
 *
 * The field's border and background are the row's rather than the input's, so the
 * generated `Input` is not used here: the prototype draws the pane count inside the same
 * box as the text, which is one control and not a control beside a label.
 */
export function AddressBar({
  project,
  onNavigate
}: {
  project: Project | null
  /** Resolves false if the route refused it, which is when the typed text is worth keeping. */
  onNavigate(url: string): Promise<boolean>
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? project?.startUrl ?? ''
  // Expanded here only to disable the commit; the route expands it again for real, so a
  // bare port means the same thing typed here and typed at a terminal.
  const navigable = expandUrl(value) !== undefined

  return (
    <form
      className="flex min-w-[var(--bp-address-min-w)] max-w-[var(--bp-address-w)] flex-1 items-center gap-[var(--bp-space-3)] rounded-[var(--bp-radius-sm)] border border-[color:var(--bp-border-strong)] bg-[var(--bp-chrome-sunken)] px-[var(--bp-space-3)]"
      style={{ height: 'var(--bp-row-lg)' }}
      data-testid="address-bar"
      onSubmit={(event) => {
        event.preventDefault()
        if (!navigable) return
        // Held until it lands. A refused navigation that silently restored the old URL
        // would lose what was typed and say nothing about why.
        const submitted = value
        void onNavigate(submitted).then((ok) => {
          if (ok) setDraft((current) => (current === submitted ? null : current))
        })
      }}
    >
      <input
        aria-label="Address"
        data-testid="project-url"
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder="localhost:3000, or any URL"
        // Opened from the Dock, this is the only thing in the window to do.
        autoFocus={project === null}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
        }}
        className="min-w-0 flex-1 bg-transparent font-mono placeholder:text-[color:var(--bp-ink-faint)] text-[length:var(--bp-text-lg)] text-[color:var(--bp-ink)] outline-none"
      />
      {project && (
        <span
          className="flex-none font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-ink-faint)]"
          data-testid="pane-count"
        >
          {project.panes.length} {project.panes.length === 1 ? 'pane' : 'panes'}
        </span>
      )}
    </form>
  )
}
