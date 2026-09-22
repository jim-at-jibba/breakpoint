import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../../shared/project'
import { expandUrl, originOf, sameOrigins } from '../../../shared/urls'

/**
 * The project's allowed origins, edited in place. They bind automation and nothing else:
 * nothing here constrains what the developer types in the address bar or clicks inside a
 * pane ([ADR-0013]), which is why the list is a small setting rather than a security
 * surface with a warning on it.
 *
 * The whole list is sent on every edit, because that is what the route takes: a set
 * replaced is one call that either happened or did not, where an add and a remove would
 * be two that can half-happen. Failures are reported here rather than in the toolbar, so
 * the message sits beside the list it is about.
 */
export function AllowedOrigins({ project }: { project: Project }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const { allowedOrigins } = project
  const [optimisticOrigins, setOptimisticOrigins] = useState<string[] | null>(null)
  const desiredOrigins = useRef(allowedOrigins)
  const projectOrigins = useRef(allowedOrigins)
  const sending = useRef(false)
  const origins = optimisticOrigins ?? allowedOrigins

  useEffect(() => {
    projectOrigins.current = allowedOrigins
    if (optimisticOrigins === null) {
      desiredOrigins.current = allowedOrigins
    } else if (!sending.current && sameOrigins(allowedOrigins, optimisticOrigins)) {
      desiredOrigins.current = allowedOrigins
      setOptimisticOrigins(null)
    }
  }, [allowedOrigins, optimisticOrigins])

  // Expanded exactly as the address bar expands it, so `localhost:3000` is an origin
  // here too: a list that refuses what the rest of the app accepts is a dead end.
  const expanded = expandUrl(draft)
  const addition = expanded === undefined ? undefined : originOf(expanded)
  const addable = addition !== undefined && !origins.includes(addition)

  function edit(change: (current: string[]) => string[]): void {
    const next = change(desiredOrigins.current)
    if (sameOrigins(next, desiredOrigins.current)) return
    desiredOrigins.current = next
    setOptimisticOrigins(next)
    void flushEdits()
  }

  async function flushEdits(): Promise<void> {
    if (sending.current) return
    sending.current = true
    setMessage(null)
    try {
      while (true) {
        const target = desiredOrigins.current
        const response = await window.breakpoint.invoke('project.setAllowedOrigins', {
          origins: target
        })
        if (!response.ok) {
          desiredOrigins.current = projectOrigins.current
          setOptimisticOrigins(null)
          setMessage(response.error.message)
          return
        }
        if (sameOrigins(target, desiredOrigins.current)) return
      }
    } catch (error) {
      desiredOrigins.current = projectOrigins.current
      setOptimisticOrigins(null)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      sending.current = false
      if (sameOrigins(projectOrigins.current, desiredOrigins.current)) {
        setOptimisticOrigins(null)
      }
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        setDraft('')
        setMessage(null)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            title="The origins automation may navigate this project to"
            aria-label="Allowed origins"
            data-testid="allowed-origins"
          >
            Origins {origins.length}
          </Button>
        }
      />
      <PopoverContent align="end" data-testid="allowed-origins-menu">
        <div className="flex flex-col">
          <p className="px-[var(--bp-space-2)] pb-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
            Where <code className="font-mono">breakpoint open</code> may send the panes. Typing a
            URL here in the address bar is never held to it.
          </p>
          {origins.length === 0 && (
            <span
              className="px-[var(--bp-space-2)] py-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
              data-testid="allowed-origins-empty"
            >
              No origins. Automation cannot navigate this project.
            </span>
          )}
          {origins.map((origin) => (
            <div
              key={origin}
              data-testid="allowed-origin"
              data-origin={origin}
              className="flex h-[var(--bp-row-md)] items-center gap-[var(--bp-space-3)] rounded-[var(--bp-radius-sm)] px-[var(--bp-space-2)] hover:bg-[var(--bp-hover)]"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink)]">
                {origin}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${origin}`}
                data-testid="remove-origin"
                data-origin={origin}
                className="flex-none text-[color:var(--bp-ink-faint)]"
                onClick={() =>
                  edit((current) => current.filter((candidate) => candidate !== origin))
                }
              >
                ×
              </Button>
            </div>
          ))}
        </div>
        <form
          className="flex items-center gap-[var(--bp-space-2)] border-t border-[color:var(--bp-border)] pt-[var(--bp-space-2)]"
          onSubmit={(event) => {
            event.preventDefault()
            if (!addable) return
            setDraft('')
            edit((current) => [...current, addition])
          }}
        >
          <Input
            aria-label="Origin"
            placeholder="staging.example.com"
            spellCheck={false}
            autoComplete="off"
            value={draft}
            data-testid="add-origin-value"
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            type="submit"
            size="xs"
            variant="outline"
            disabled={!addable}
            data-testid="add-origin"
            className="flex-none"
          >
            Add
          </Button>
        </form>
        {message !== null && (
          <span
            role="alert"
            data-testid="allowed-origins-error"
            className="px-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
          >
            {message}
          </span>
        )}
      </PopoverContent>
    </Popover>
  )
}
