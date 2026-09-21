import { useEffect, useRef, useState } from 'react'
import type { PaneStatus } from '../../../shared/panes'
import { describeDegradation, isPaneDimension, paneWebPreferences } from '../../../shared/panes'
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
        {project.panes.length === 0 && (
          <p
            className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
            data-testid="canvas-empty"
          >
            No panes. Add one from a preset or at a size of your own.
          </p>
        )}
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
        {pane.name}
      </span>
      <PaneSize pane={pane} />
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
          onClick={() => window.breakpoint.invoke('panes.rotate', { pane: pane.id })}
        >
          ⤢
        </PaneAction>
        <PaneAction
          label="Remove"
          testId="pane-remove"
          pane={pane.id}
          onClick={() => window.breakpoint.invoke('panes.remove', { pane: pane.id })}
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
function PaneSize({ pane }: { pane: Pane }): React.JSX.Element {
  function resize(size: { width: number } | { height: number }): void {
    void window.breakpoint.invoke('panes.resize', { pane: pane.id, ...size })
  }

  return (
    <span className="flex flex-none items-center font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-ink-muted)]">
      <SizeInput
        label="Width"
        pane={pane.id}
        declared={pane.width}
        onCommit={(width) => resize({ width })}
      />
      ×
      <SizeInput
        label="Height"
        pane={pane.id}
        declared={pane.height}
        onCommit={(height) => resize({ height })}
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
          event.currentTarget.blur()
        }
      }}
      className="w-[4ch] rounded-[var(--bp-radius-xs)] bg-transparent text-center tabular-nums outline-none hover:bg-[var(--bp-hover)] focus:bg-[var(--bp-chrome-sunken)] focus:text-[color:var(--bp-ink)]"
    />
  )
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
