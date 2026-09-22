import { AddPane } from '@renderer/components/add-pane'
import { Canvas } from '@renderer/components/canvas'
import { CanvasControls } from '@renderer/components/canvas-controls'
import { Button } from '@renderer/components/ui/button'
import { useSnapshot } from '@renderer/hooks/use-snapshot'
import { useState } from 'react'
import { MAX_ZOOM } from '../../shared/canvas'
import type { Project, Zoom } from '../../shared/project'
import type { LayoutSetting, RouteName, RouteParams } from '../../shared/routes'

interface ZoomPreview {
  project: Project
  zoom: number
}

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
  // What the canvas draws at is the canvas's to settle and the toolbar's to show, so it
  // is held here between them. It is never stored: only the value `Fit` is (ADR-0009).
  const [zoom, setZoom] = useState(MAX_ZOOM)
  const [zoomPreview, setZoomPreview] = useState<ZoomPreview | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const activeZoomPreview = zoomPreview?.project === project ? zoomPreview.zoom : null

  const invokeAction = async <N extends RouteName>(
    route: N,
    params: RouteParams<N>
  ): Promise<boolean> => {
    try {
      const response = await window.breakpoint.invoke(route, params)
      if (!response.ok) {
        setActionError(`${response.error.code}: ${response.error.message}`)
        return false
      }
      setActionError(null)
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const setLayout = (setting: LayoutSetting): void => {
    setZoomPreview(null)
    void invokeAction('project.setLayout', setting)
  }

  const previewZoom = (value: number): void => {
    if (project) setZoomPreview({ project, zoom: value })
  }

  const commitZoom = (value: Zoom): void => {
    if (value === 'fit') {
      setZoomPreview(null)
    } else if (project) {
      setZoomPreview({ project, zoom: value })
    }
    void invokeAction('project.setZoom', { zoom: value }).then((ok) => {
      if (!ok || project?.zoom === value) setZoomPreview(null)
    })
  }

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
        {actionError && (
          <span
            role="alert"
            className="truncate text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
          >
            Could not update canvas: {actionError}
          </span>
        )}
        {project && (
          <div className="ml-auto flex items-center gap-[var(--bp-space-3)]">
            <AddPane />
            <CanvasControls
              project={project}
              zoom={activeZoomPreview ?? zoom}
              previewing={activeZoomPreview !== null}
              onLayout={setLayout}
              onZoomPreview={previewZoom}
              onZoomCommit={commitZoom}
            />
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className={project ? 'mr-[var(--bp-space-4)]' : 'ml-auto mr-[var(--bp-space-4)]'}
          onClick={() => void window.breakpoint.invoke('app.quit')}
        >
          Quit
        </Button>
      </header>
      {project && snapshot ? (
        <Canvas
          project={project}
          statuses={snapshot.panes}
          zoomPreview={activeZoomPreview}
          onZoom={setZoom}
          onFocusPane={(pane) => setLayout({ layout: 'focus', focusedPane: pane })}
        />
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
