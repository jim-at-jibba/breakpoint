import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useRef, useState } from 'react'
import type { ThemePreference, ThemeState } from '../../../shared/theme'

const CHOICES: ReadonlyArray<{ preference: ThemePreference; label: string }> = [
  { preference: 'system', label: 'System' },
  { preference: 'light', label: 'Light' },
  { preference: 'dark', label: 'Dark' }
]

/**
 * The app theme, in settings, where PRD 8.2's Appearance panel will keep it. Three
 * choices and no more: follow the desktop, or override it in either direction for a
 * developer who wants the tool dark on a light desktop.
 *
 * App-level rather than a project's, which is why it sits beside the certificates and
 * does not go away when a project closes. It is not a pane's colour scheme and changes
 * no pane: those live on the panes themselves, as emulation.
 */
export function AppThemeControl({ theme }: { theme: ThemeState }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const choiceVersion = useRef(0)
  const chosen = CHOICES.find((choice) => choice.preference === theme.preference)

  async function choose(preference: ThemePreference): Promise<void> {
    const version = choiceVersion.current + 1
    choiceVersion.current = version
    setMessage(null)
    try {
      const response = await window.breakpoint.invoke('app.setTheme', { preference })
      if (choiceVersion.current !== version) return
      setMessage(response.ok ? null : response.error.message)
    } catch (error) {
      if (choiceVersion.current === version) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        setMessage(null)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            title="Whether Breakpoint's own chrome is light or dark"
            aria-label="App theme"
            data-testid="app-theme"
            data-preference={theme.preference}
            data-active={theme.active}
          >
            Theme {chosen?.label ?? theme.preference}
          </Button>
        }
      />
      <PopoverContent align="end" data-testid="app-theme-menu">
        <div className="flex flex-col">
          <p className="px-[var(--bp-space-2)] pb-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
            Breakpoint&rsquo;s own chrome. A pane&rsquo;s colour scheme is emulation and is set on
            the pane.
          </p>
          {CHOICES.map((choice) => (
            <Button
              key={choice.preference}
              size="sm"
              variant="ghost"
              role="menuitemradio"
              aria-checked={choice.preference === theme.preference}
              data-testid="app-theme-choice"
              data-preference={choice.preference}
              className="justify-start"
              onClick={() => void choose(choice.preference)}
            >
              <span
                aria-hidden
                className="w-[var(--bp-space-4)] flex-none text-[color:var(--bp-accent)]"
              >
                {choice.preference === theme.preference ? '✓' : ''}
              </span>
              {choice.label}
            </Button>
          ))}
        </div>
        {message !== null && (
          <span
            role="alert"
            data-testid="app-theme-error"
            className="px-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
          >
            {message}
          </span>
        )}
      </PopoverContent>
    </Popover>
  )
}
