import { readCanvasChrome, readStripHeight } from '@renderer/lib/canvas-chrome'
import { useEffect, useRef, useState } from 'react'
import { fitZoom, focusedPaneOf, MAX_ZOOM, resolveZoom, stripZoom } from '../../../shared/canvas'
import type { PaneStatus, Size } from '../../../shared/panes'
import { describeDegradation, paneWebPreferences } from '../../../shared/panes'
import type { Pane, Project } from '../../../shared/project'

/**
 * The canvas: the project's panes on a scrolling surface, each a `<webview>` loading the
 * start URL at its declared size.
 *
 * Zoom is the renderer's own — a transform on each pane, never a size the page is told,
 * which is the entire point of the feature. Fit is a value that zoom can hold rather
 * than a layout of its own ([ADR-0009]), so this measures its own box and resolves it;
 * the main process keeps the value and never learns what it came to.
 *
 * Horizontal draws every pane at that zoom. Focus draws one at 100% with the rest as a
 * strip, so a developer can work in one viewport without losing sight of the others.
 */
export function Canvas({
  project,
  statuses,
  onZoom
}: {
  project: Project
  statuses: Readonly<Record<string, PaneStatus>>
  /** What the canvas settled on drawing at, so the toolbar cannot read a different number. */
  onZoom: (zoom: number) => void
}): React.JSX.Element {
  const canvas = useRef<HTMLDivElement>(null)
  const fit = useFit(canvas, project)
  // Focus draws its pane at 100%, so Fit has nothing to say about that layout.
  const zoom = project.layout === 'focus' ? MAX_ZOOM : resolveZoom(project.zoom, fit)

  useEffect(() => {
    onZoom(zoom)
  }, [onZoom, zoom])

  if (project.layout === 'focus') {
    return <FocusLayout ref={canvas} project={project} statuses={statuses} />
  }

  return (
    <div
      ref={canvas}
      className="min-h-0 flex-1 overflow-auto bg-[var(--bp-canvas)]"
      data-testid="canvas"
      data-layout="horizontal"
      data-zoom={zoom}
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

/**
 * One pane at 100% on the canvas, the others as a strip above it. The strip is a picker:
 * its panes render live, but nothing inside one is clickable, so a click on one is a
 * click on the pane rather than on the page it is showing.
 */
function FocusLayout({
  ref,
  project,
  statuses
}: {
  ref: React.RefObject<HTMLDivElement | null>
  project: Project
  statuses: Readonly<Record<string, PaneStatus>>
}): React.JSX.Element {
  // The token, read once: it is on the root and does not change while the window is open.
  const [stripHeight] = useState(() => readStripHeight(document.documentElement))
  const focused = focusedPaneOf(project.panes, project.focusedPane)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bp-canvas)]">
      <div
        className="flex shrink-0 items-start gap-[var(--bp-space-3)] overflow-x-auto px-[var(--bp-space-5)] pt-[var(--bp-space-5)]"
        data-testid="strip"
      >
        {project.panes.map((pane, index) =>
          pane.id === focused?.id ? null : (
            <PaneView
              key={pane.id}
              pane={pane}
              index={index}
              zoom={stripZoom(pane, stripHeight)}
              url={project.startUrl}
              status={statuses[pane.id]}
              onFocus={() =>
                void window.breakpoint.invoke('project.setLayout', {
                  layout: 'focus',
                  focusedPane: pane.id
                })
              }
            />
          )
        )}
      </div>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-auto"
        data-testid="canvas"
        data-layout="focus"
        data-zoom={MAX_ZOOM}
      >
        <div className="flex min-h-full w-max items-start p-[var(--bp-space-5)]">
          {focused && (
            <PaneView
              pane={focused}
              index={project.panes.indexOf(focused)}
              zoom={MAX_ZOOM}
              url={project.startUrl}
              status={statuses[focused.id]}
              focused
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Fit, recomputed whenever the canvas is resized or a pane is added, removed or resized.
 * The pane set is watched by its declared sizes rather than by identity: a new snapshot
 * object arrives on every patch, and only a size in it changes what fits.
 */
function useFit(canvas: React.RefObject<HTMLDivElement | null>, project: Project): number {
  const [fit, setFit] = useState(MAX_ZOOM)
  const sizes = project.panes.map(({ width, height }) => ({ width, height }))
  const key = `${project.layout} ${sizes.map(({ width, height }) => `${width}x${height}`).join(' ')}`

  // Kept current in an effect rather than in render: what the next measurement should
  // read is not something a render decides.
  const latest = useRef(sizes)
  useEffect(() => {
    latest.current = sizes
  })

  useEffect(() => {
    const element = canvas.current
    if (!element) return

    const measure = (): void => {
      const viewport = { width: element.clientWidth, height: element.clientHeight }
      setFit(fitZoom(latest.current, viewport, readCanvasChrome(element)))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [canvas, key])

  return fit
}

function PaneView({
  pane,
  index,
  zoom,
  url,
  status,
  focused,
  onFocus
}: {
  pane: Pane
  index: number
  /** Percent. What this pane is drawn at, which is not always the canvas zoom. */
  zoom: number
  url: string
  status: PaneStatus | undefined
  focused?: boolean
  /** Given to a pane in the Focus strip: clicking it makes it the focused pane. */
  onFocus?: () => void
}): React.JSX.Element {
  const webview = useRef<HTMLWebViewElement>(null)
  useGeometryCheck(webview, pane, zoom)

  const degraded = status?.degraded ?? []
  const drawn = drawnSize(pane, zoom)

  return (
    <div
      className="flex-none rounded-[var(--bp-radius-sm)] bg-[var(--bp-chrome)] px-[var(--bp-stroke)] pb-[var(--bp-stroke)]"
      data-testid="pane"
      data-pane={pane.id}
      data-zoom={zoom}
      data-focused={focused ? 'true' : undefined}
      data-degraded={degraded.length > 0 ? 'true' : undefined}
      style={
        {
          // A degraded pane is a rim-and-header event: drawn on ground we own, never over the page.
          boxShadow:
            degraded.length > 0
              ? '0 0 0 var(--bp-stroke) var(--bp-warn), var(--bp-shadow-pane)'
              : 'var(--bp-shadow-pane)',
          // Overlay strokes counter-scale against the zoom of the pane they are drawn over,
          // which in Focus is not the zoom of the pane beside it.
          '--bp-zoom': zoom / 100
        } as React.CSSProperties
      }
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
            transform: `scale(${zoom / 100})`,
            transformOrigin: '0 0',
            // A strip pane is a picker, not a page to work in: the click belongs to us.
            pointerEvents: onFocus ? 'none' : undefined
          }}
        />
        {onFocus && (
          <button
            type="button"
            className="absolute inset-0 cursor-pointer"
            data-testid="focus-pane"
            data-pane={pane.id}
            onClick={onFocus}
          >
            <span className="sr-only">Focus {pane.name}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The host-side geometry check ([ADR-0004]), on every attach and resize: the element's
 * own rendered box against its declared size times the zoom it is drawn at. The main
 * process decides what the comparison means; nothing here corrects a pane that fails it.
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
        expected: drawnSize({ width, height }, zoom),
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

/** Screen pixels: what a pane declares, drawn at the zoom it is drawn at. */
function drawnSize({ width, height }: Size, zoom: number): Size {
  return { width: (width * zoom) / 100, height: (height * zoom) / 100 }
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
