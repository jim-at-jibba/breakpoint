import { AddPane } from '@renderer/components/add-pane'
import { Canvas } from '@renderer/components/canvas'
import { Button } from '@renderer/components/ui/button'
import { useSnapshot } from '@renderer/hooks/use-snapshot'

// The shell, ahead of the real toolbar. The toolbar strip is the window's drag region
// and clears the traffic lights; it names the open project and its start URL. The body
// is the canvas once a project is open, and says what to do when nothing is.
//
// Quit stays in the toolbar as the renderer's end of the route table: the button causes
// `app.quit` over typed IPC and a terminal causes the same route over the socket — one
// table, no UI-only route (ADR-0005). It goes away with the real toolbar.
export default function App(): React.JSX.Element {
  const state = useSnapshot()
  const snapshot = state.snapshot
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
            {state.status === 'fetching' ? 'Loading project…' : 'No project open'}
          </span>
        )}
        {state.status === 'error' && (
          <>
            <span
              role="alert"
              className="truncate text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
            >
              Could not {snapshot ? 'refresh' : 'load'} project: {state.message}
            </span>
            <Button size="sm" variant="outline" onClick={state.retry}>
              Retry
            </Button>
          </>
        )}
        {state.status === 'fetching' && snapshot && (
          <span
            role="status"
            className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
          >
            Refreshing project…
          </span>
        )}
        <div className="ml-auto mr-[var(--bp-space-4)] flex items-center gap-[var(--bp-space-2)]">
          {project && <AddPane />}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void window.breakpoint.invoke('app.quit')}
          >
            Quit
          </Button>
        </div>
      </header>
      {project && snapshot ? (
        <Canvas project={project} statuses={snapshot.panes} />
      ) : (
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
        </main>
      )}
    </div>
  )
}
