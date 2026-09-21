import { Button } from '@renderer/components/ui/button'
import { useSnapshot } from '@renderer/hooks/use-snapshot'

// The shell, ahead of the real toolbar and canvas. The toolbar strip is the window's
// drag region and clears the traffic lights; it names the open project and its start
// URL, which is the first real state the renderer projects. The body says what to do
// when nothing is open, and otherwise waits for the canvas (#10).
//
// Quit stays here as the renderer's end of the route table: the button causes `app.quit`
// over typed IPC and a terminal causes the same route over the socket — one table, no
// UI-only route (ADR-0005). It goes away with the real toolbar.
export default function App(): React.JSX.Element {
  const snapshot = useSnapshot()
  const project = snapshot?.project ?? null

  return (
    <div className="flex h-screen flex-col">
      <header
        className="bp-drag border-border flex shrink-0 items-center gap-3 border-b"
        style={{ height: 'var(--bp-toolbar-h)', paddingLeft: 88 }}
      >
        {project ? (
          <>
            <span
              className="text-[length:var(--bp-text-sm)] font-medium text-[color:var(--bp-ink)]"
              data-testid="project-name"
            >
              {project.name}
            </span>
            <span
              className="font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
              data-testid="project-url"
            >
              {project.startUrl}
            </span>
          </>
        ) : (
          <span className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
            No project open
          </span>
        )}
      </header>
      <main className="bg-background text-foreground flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className="size-2 rounded-xs"
            style={{ background: 'var(--bp-pane-1)' }}
            aria-hidden
          />
          <span className="font-mono text-[length:var(--bp-text-lg)]">breakpoint</span>
        </div>
        {!project && snapshot && (
          <p className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
            Run <code className="font-mono">breakpoint .</code> in a repo to open a project.
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void window.breakpoint.invoke('app.quit')}
        >
          Quit
        </Button>
      </main>
    </div>
  )
}
