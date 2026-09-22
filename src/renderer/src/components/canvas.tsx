import { readCanvasChrome, readStripGap, readStripHeight } from '@renderer/lib/canvas-chrome'
import { useEffect, useRef, useState } from 'react'
import {
  fitZoom,
  focusedPaneOf,
  MAX_ZOOM,
  resolveZoom,
  stripZoom,
  type CanvasChrome
} from '../../../shared/canvas'
import type { PaneStatus, Size } from '../../../shared/panes'
import { describeDegradation, isPaneDimension, paneWebPreferences } from '../../../shared/panes'
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
  zoomPreview,
  onZoom,
  onFocusPane
}: {
  project: Project
  statuses: Readonly<Record<string, PaneStatus>>
  /** A slider value being manipulated, before it is committed to the project. */
  zoomPreview: number | null
  /** What the canvas settled on drawing at, so the toolbar cannot read a different number. */
  onZoom: (zoom: number) => void
  onFocusPane: (pane: string) => void
}): React.JSX.Element {
  const canvas = useRef<HTMLDivElement>(null)
  const fit = useFit(canvas, project)
  const [focusChrome] = useState(() => {
    const root = document.documentElement
    return {
      canvas: readCanvasChrome(root),
      stripGap: readStripGap(root),
      stripHeight: readStripHeight(root)
    }
  })
  // Focus draws its pane at 100%, so Fit has nothing to say about that layout.
  const zoom =
    project.layout === 'focus' ? MAX_ZOOM : (zoomPreview ?? resolveZoom(project.zoom, fit))
  const focused = focusedPaneOf(project.panes, project.focusedPane)
  const focus =
    project.layout === 'focus'
      ? arrangeFocus(project.panes, focused, focusChrome.canvas, focusChrome)
      : undefined

  useEffect(() => {
    onZoom(zoom)
  }, [onZoom, zoom])

  return (
    <div
      ref={canvas}
      className="min-h-0 flex-1 overflow-auto bg-[var(--bp-canvas)]"
      data-testid="canvas"
      data-layout={project.layout}
      data-zoom={zoom}
    >
      <div
        className={
          project.layout === 'horizontal'
            ? 'flex min-h-full w-max items-start gap-[var(--bp-space-5)] p-[var(--bp-space-5)]'
            : 'relative min-h-full'
        }
        style={focus?.stage}
      >
        {project.panes.length === 0 && (
          <p
            className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
            data-testid="canvas-empty"
          >
            No panes. Add one from a preset or at a size of your own.
          </p>
        )}
        {project.panes.map((pane, index) => {
          const focusedPane = project.layout === 'focus' && pane.id === focused?.id
          const paneZoom =
            project.layout === 'horizontal'
              ? zoom
              : focusedPane
                ? MAX_ZOOM
                : stripZoom(pane, focusChrome.stripHeight)
          return (
            <PaneView
              key={pane.id}
              pane={pane}
              index={index}
              zoom={paneZoom}
              url={project.startUrl}
              status={statuses[pane.id]}
              focused={focusedPane}
              strip={project.layout === 'focus' && !focusedPane}
              placement={focus?.panes.get(pane.id)}
              onFocus={
                project.layout === 'focus' && !focusedPane ? () => onFocusPane(pane.id) : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
}

interface FocusChrome {
  stripGap: number
  stripHeight: number
}

interface FocusArrangement {
  stage: React.CSSProperties
  panes: ReadonlyMap<string, React.CSSProperties>
}

/** One stable pane tree, positioned into a strip and a 100% work area without remounting guests. */
function arrangeFocus(
  panes: readonly Pane[],
  focused: Pane | undefined,
  chrome: CanvasChrome,
  focusChrome: FocusChrome
): FocusArrangement {
  const positions = new Map<string, React.CSSProperties>()
  const strip = panes.filter((pane) => pane.id !== focused?.id)
  let left = chrome.padding
  let stripHeight = 0

  for (const pane of strip) {
    const zoom = stripZoom(pane, focusChrome.stripHeight)
    const frame = frameSize(pane, zoom, chrome)
    positions.set(pane.id, { position: 'absolute', left, top: chrome.padding })
    left += frame.width + focusChrome.stripGap
    stripHeight = Math.max(stripHeight, frame.height)
  }

  const stripWidth = strip.length > 0 ? left - chrome.padding - focusChrome.stripGap : 0
  const focusedFrame = focused ? frameSize(focused, MAX_ZOOM, chrome) : { width: 0, height: 0 }
  const focusedTop = chrome.padding + (strip.length > 0 ? stripHeight + chrome.gap : 0)
  if (focused) {
    positions.set(focused.id, { position: 'absolute', left: chrome.padding, top: focusedTop })
  }

  return {
    stage: {
      width: chrome.padding * 2 + Math.max(stripWidth, focusedFrame.width),
      height: focusedTop + focusedFrame.height + chrome.padding
    },
    panes: positions
  }
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
  strip,
  placement,
  onFocus
}: {
  pane: Pane
  index: number
  /** Percent. What this pane is drawn at, which is not always the canvas zoom. */
  zoom: number
  url: string
  status: PaneStatus | undefined
  focused?: boolean
  strip?: boolean
  placement?: React.CSSProperties
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
      data-strip={strip ? 'true' : undefined}
      data-degraded={degraded.length > 0 ? 'true' : undefined}
      style={
        {
          ...placement,
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

function frameSize(pane: Pane, zoom: number, chrome: CanvasChrome): Size {
  const page = drawnSize(pane, zoom)
  return { width: page.width + chrome.pane.width, height: page.height + chrome.pane.height }
}

/**
 * Holds its screen size whatever the zoom and is clipped by its own pane, so it can never
 * claim width the pane does not have.
 *
 * The size fields, rotate and remove are the developer's end of `panes.resize`,
 * `panes.rotate` and `panes.remove` — no route here the terminal cannot reach
 * ([ADR-0005]). They are drawn at every width for now; tiering them away as the pane
 * narrows is the degradation ladder's business (#14, [ADR-0010]).
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
  const [message, setMessage] = useState<string | null>(null)
  const actionVersion = useRef(0)

  async function runAction(
    action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>
  ): Promise<void> {
    const version = actionVersion.current + 1
    actionVersion.current = version
    setMessage(null)
    try {
      const response = await action()
      if (actionVersion.current !== version) return
      setMessage(response.ok ? null : response.error.message)
    } catch (error) {
      if (actionVersion.current === version) setMessage(errorMessage(error))
    }
  }

  function resize(size: { width: number } | { height: number }): Promise<void> {
    return runAction(() => window.breakpoint.invoke('panes.resize', { pane: pane.id, ...size }))
  }

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
        {pane.name}
      </span>
      <PaneSize pane={pane} onResize={resize} />
      {message !== null && (
        <span
          role="alert"
          data-testid="pane-action-error"
          title={message}
          className="min-w-0 truncate font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-error)]"
        >
          {message}
        </span>
      )}
      {degraded.length > 0 && (
        <span
          className="flex-none font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-warn)]"
          data-testid="pane-degraded"
          title={reasons}
        >
          degraded
        </span>
      )}
      <div className="ml-auto flex flex-none items-center gap-[var(--bp-space-1)]">
        <PaneAction
          label="Rotate"
          testId="pane-rotate"
          pane={pane.id}
          onClick={() =>
            void runAction(() => window.breakpoint.invoke('panes.rotate', { pane: pane.id }))
          }
        >
          ⤢
        </PaneAction>
        <PaneAction
          label="Remove"
          testId="pane-remove"
          pane={pane.id}
          onClick={() =>
            void runAction(() => window.breakpoint.invoke('panes.remove', { pane: pane.id }))
          }
        >
          ×
        </PaneAction>
      </div>
    </div>
  )
}

/**
 * The pane's declared size, typed. Each field shows what the pane declares until it is
 * edited, and commits only itself, so committing a width can never carry a height the
 * pane no longer has.
 */
function PaneSize({
  pane,
  onResize
}: {
  pane: Pane
  onResize(size: { width: number } | { height: number }): Promise<void>
}): React.JSX.Element {
  return (
    <span className="flex flex-none items-center font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-ink-muted)]">
      <SizeInput
        label="Width"
        pane={pane.id}
        declared={pane.width}
        onCommit={(width) => void onResize({ width })}
      />
      ×
      <SizeInput
        label="Height"
        pane={pane.id}
        declared={pane.height}
        onCommit={(height) => void onResize({ height })}
      />
    </span>
  )
}

/**
 * Shows the declared value while it is not being edited, so a resize from anywhere — the
 * CLI, a rotation, another window — is simply what the field says next. A value the route
 * would refuse is never sent; the field goes back to showing what the pane declares.
 */
function SizeInput({
  label,
  pane,
  declared,
  onCommit
}: {
  label: string
  pane: string
  declared: number
  onCommit(value: number): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? String(declared)

  function commit(): void {
    const next = Number(draft)
    setDraft(null)
    if (draft === null || !isPaneDimension(next) || next === declared) return
    onCommit(next)
  }

  return (
    <input
      aria-label={`${label} of ${pane}`}
      data-testid={`pane-${label.toLowerCase()}`}
      inputMode="numeric"
      value={value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(null)
        }
      }}
      className="w-[var(--bp-field-w-inline)] rounded-[var(--bp-radius-xs)] bg-transparent text-center tabular-nums outline-none hover:bg-[var(--bp-hover)] focus:bg-[var(--bp-chrome-sunken)] focus:text-[color:var(--bp-ink)]"
    />
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PaneAction({
  label,
  testId,
  pane,
  onClick,
  children
}: {
  label: string
  testId: string
  pane: string
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={`${label} ${pane}`}
      data-testid={testId}
      data-pane={pane}
      onClick={onClick}
      className="grid size-[var(--bp-pane-tab-h)] place-items-center rounded-[var(--bp-radius-xs)] text-[length:var(--bp-text-micro)] leading-none text-[color:var(--bp-ink-faint)] hover:bg-[var(--bp-hover)] hover:text-[color:var(--bp-ink)]"
    >
      {children}
    </button>
  )
}
