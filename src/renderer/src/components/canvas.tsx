import { useEffect, useRef } from 'react'
import type { PaneStatus } from '../../../shared/panes'
import { describeDegradation, paneWebPreferences } from '../../../shared/panes'
import type { Pane, Project } from '../../../shared/project'

/**
 * The canvas: the project's panes side by side on a horizontally scrolling surface, each
 * a `<webview>` loading the start URL at its declared size.
 *
 * Zoom is the renderer's own ([ADR-0009]): a transform on each pane, never a size the
 * page is told. Fit is computed in #13; until then it draws at 100%.
 */
export function Canvas({
  project,
  statuses
}: {
  project: Project
  statuses: Readonly<Record<string, PaneStatus>>
}): React.JSX.Element {
  const zoom = typeof project.zoom === 'number' ? project.zoom / 100 : 1

  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-[var(--bp-canvas)]"
      data-testid="canvas"
      style={{ '--bp-zoom': zoom } as React.CSSProperties}
    >
      <div className="flex min-h-full w-max items-start gap-[var(--bp-space-5)] p-[var(--bp-space-5)]">
        {project.panes.map((pane, index) => (
          <PaneView
            key={pane.id}
            pane={pane}
            index={index}
            zoom={zoom}
            url={project.startUrl}
            status={statuses[pane.id]}
          />
        ))}
      </div>
    </div>
  )
}

function PaneView({
  pane,
  index,
  zoom,
  url,
  status
}: {
  pane: Pane
  index: number
  zoom: number
  url: string
  status: PaneStatus | undefined
}): React.JSX.Element {
  const webview = useRef<HTMLWebViewElement>(null)
  useGeometryCheck(webview, pane, zoom)

  const degraded = status?.degraded ?? []
  const drawn = { width: pane.width * zoom, height: pane.height * zoom }

  return (
    <div
      className="flex-none rounded-[var(--bp-radius-sm)] bg-[var(--bp-chrome)] px-[var(--bp-stroke)] pb-[var(--bp-stroke)]"
      data-testid="pane"
      data-pane={pane.id}
      data-degraded={degraded.length > 0 ? 'true' : undefined}
      style={{
        // A degraded pane is a rim-and-header event: drawn on ground we own, never over the page.
        boxShadow:
          degraded.length > 0
            ? '0 0 0 var(--bp-stroke) var(--bp-warn), var(--bp-shadow-pane)'
            : 'var(--bp-shadow-pane)'
      }}
    >
      <PaneHeader pane={pane} index={index} width={drawn.width} degraded={degraded} />
      <div className="relative overflow-hidden" style={drawn}>
        {/* Never override the element's display: Electron lays the guest out with flex,
            and anything else collapses it to 150px tall while emulation reports the
            declared height (Phase 0, ADR-0004). */}
        <webview
          ref={webview}
          src={url}
          partition={`persist:${pane.session}`}
          webpreferences={paneWebPreferences(pane.id)}
          data-pane={pane.id}
          style={{
            width: pane.width,
            height: pane.height,
            transform: `scale(${zoom})`,
            transformOrigin: '0 0'
          }}
        />
      </div>
    </div>
  )
}

/**
 * The host-side geometry check ([ADR-0004]), on every attach and resize: the element's
 * own rendered box against its declared size times the zoom. The main process decides
 * what the comparison means; nothing here corrects a pane that fails it.
 */
function useGeometryCheck(
  webview: React.RefObject<HTMLWebViewElement | null>,
  pane: Pane,
  zoom: number
): void {
  const { id, width, height } = pane

  useEffect(() => {
    const element = webview.current
    if (!element) return

    const check = (): void => {
      const box = element.getBoundingClientRect()
      void window.breakpoint.invoke('panes.reportGeometry', {
        pane: id,
        expected: { width: width * zoom, height: height * zoom },
        measured: { width: box.width, height: box.height }
      })
    }

    // A resize of the element fires the observer; a new guest fires `did-attach`, and
    // the main process has forgotten the old guest's geometry by then.
    const observer = new ResizeObserver(check)
    observer.observe(element)
    element.addEventListener('did-attach', check)
    return () => {
      observer.disconnect()
      element.removeEventListener('did-attach', check)
    }
  }, [webview, id, width, height, zoom])
}

/**
 * Holds its screen size whatever the zoom and is clipped by its own pane, so it can never
 * claim width the pane does not have. The degradation ladder is #14.
 */
function PaneHeader({
  pane,
  index,
  width,
  degraded
}: {
  pane: Pane
  index: number
  width: number
  degraded: PaneStatus['degraded']
}): React.JSX.Element {
  const reasons = degraded.map(describeDegradation).join('\n')

  return (
    <div
      className="flex h-[var(--bp-row)] items-center gap-[var(--bp-space-2)] overflow-hidden pr-[var(--bp-space-2)]"
      style={{ width }}
    >
      <span
        className="h-[var(--bp-pane-tab-h)] w-[var(--bp-pane-tab-w)] flex-none rounded-r-[var(--bp-radius-xs)]"
        style={{ background: `var(--bp-pane-${(index % 10) + 1})` }}
        aria-hidden
      />
      <span className="min-w-0 truncate font-mono text-[length:var(--bp-text-micro)] whitespace-nowrap text-[color:var(--bp-ink)]">
        {pane.name} {pane.width}×{pane.height}
      </span>
      {degraded.length > 0 && (
        <span
          className="ml-auto flex-none font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-warn)]"
          data-testid="pane-degraded"
          title={reasons}
        >
          degraded
        </span>
      )}
    </div>
  )
}
