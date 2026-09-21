import { MAX_ZOOM, MIN_ZOOM } from '../../../shared/canvas'
import type { Layout, Project, Zoom } from '../../../shared/project'

const LAYOUTS: ReadonlyArray<{ value: Layout; label: string }> = [
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'focus', label: 'Focus' }
]

/**
 * The layout and zoom controls. Two layouts, and one zoom control whose value may be
 * Fit — the way a PDF reader does it, so no second control can contradict it
 * ([ADR-0009]). Touching the slider while on Fit leaves a concrete percent behind,
 * because the slider sets the value rather than a mode that computes one.
 *
 * Both causes go through the route table, so a terminal doing the same thing is the same
 * code path ([ADR-0005]).
 */
export function CanvasControls({
  project,
  zoom
}: {
  project: Project
  /**
   * What the canvas settled on drawing at. Taken from the canvas rather than worked out
   * again here, so the slider can never sit somewhere the panes deny.
   */
  zoom: number
}): React.JSX.Element {
  // Focus draws its pane at 100%, so there is nothing for the zoom to say about it; the
  // stored value is the one Horizontal comes back to.
  const zoomable = project.layout === 'horizontal'
  const fitting = zoomable && project.zoom === 'fit'

  const setLayout = (layout: Layout): void => {
    void window.breakpoint.invoke('project.setLayout', { layout })
  }
  const setZoom = (value: Zoom): void => {
    void window.breakpoint.invoke('project.setZoom', { zoom: value })
  }

  return (
    <div className="flex items-center gap-[var(--bp-space-3)]" data-testid="canvas-controls">
      <div
        role="group"
        aria-label="Layout"
        className="flex items-center gap-px rounded-[var(--bp-radius-sm)] border border-[color:var(--bp-border)] bg-[var(--bp-chrome-sunken)] p-[var(--bp-space-1)]"
      >
        {LAYOUTS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            data-testid="layout"
            data-layout={value}
            aria-pressed={project.layout === value}
            onClick={() => setLayout(value)}
            className="h-[var(--bp-row-sm)] cursor-pointer rounded-[var(--bp-radius-xs)] px-[var(--bp-space-3)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-muted)] aria-pressed:bg-[var(--bp-surface)] aria-pressed:text-[color:var(--bp-ink)]"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex h-[var(--bp-row-md)] items-center gap-[var(--bp-space-3)] rounded-[var(--bp-radius-sm)] border border-[color:var(--bp-border)] bg-[var(--bp-chrome-sunken)] px-[var(--bp-space-3)]">
        <input
          type="range"
          aria-label="Zoom"
          data-testid="zoom"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          value={zoom}
          disabled={!zoomable}
          title={zoomable ? undefined : 'Focus draws its pane at 100%'}
          className="w-[var(--bp-zoom-slider-w)] disabled:opacity-50"
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <span
          data-testid="zoom-value"
          className="w-[var(--bp-zoom-label-w)] text-right font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-muted)]"
        >
          {fitting ? 'Fit' : `${zoom}%`}
        </span>
      </div>

      <button
        type="button"
        data-testid="zoom-fit"
        aria-pressed={fitting}
        disabled={!zoomable}
        onClick={() => setZoom('fit')}
        className="h-[var(--bp-row-md)] cursor-pointer rounded-[var(--bp-radius-sm)] border border-[color:var(--bp-border-strong)] px-[var(--bp-space-3)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-muted)] disabled:opacity-50 aria-pressed:border-[color:var(--bp-accent)] aria-pressed:bg-[var(--bp-accent-wash)] aria-pressed:text-[color:var(--bp-accent-ink)]"
      >
        Fit
      </button>
    </div>
  )
}
