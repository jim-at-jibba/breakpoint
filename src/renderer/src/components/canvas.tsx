import {
  readAppTheme,
  readCanvasChrome,
  readPaneActionsWidth,
  readStripGap,
  readStripHeight
} from '@renderer/lib/canvas-chrome'
import { useEffect, useRef, useState } from 'react'
import {
  fitZoom,
  focusedPaneOf,
  MAX_ZOOM,
  resolveZoom,
  stripZoom,
  type CanvasChrome
} from '../../../shared/canvas'
import {
  describeErrors,
  describeFieldState,
  formatDpr,
  PANE_HEADER_TIERS,
  paneFieldState,
  paneHeaderHasActions,
  paneHeaderIsSilent,
  paneHeaderTier,
  schemeDiffersFromApp,
  schemeGlyph,
  type PaneHeaderTier
} from '../../../shared/pane-header'
import { paneColorVar, type AppTheme } from '../../../shared/pane-palette'
import type { CapabilityState, PaneStatus, Size } from '../../../shared/panes'
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
  const [chrome] = useState(() => {
    const root = document.documentElement
    return {
      canvas: readCanvasChrome(root),
      stripGap: readStripGap(root),
      stripHeight: readStripHeight(root),
      // What the header's own controls occupy, and the appearance its scheme glyph is
      // read against. Both hold their screen size, so both are read once.
      paneActions: readPaneActionsWidth(root),
      theme: readAppTheme(root)
    }
  })
  // Focus draws its pane at 100%, so Fit has nothing to say about that layout.
  const zoom =
    project.layout === 'focus' ? MAX_ZOOM : (zoomPreview ?? resolveZoom(project.zoom, fit))
  const focused = focusedPaneOf(project.panes, project.focusedPane)
  const focus =
    project.layout === 'focus'
      ? arrangeFocus(project.panes, focused, chrome.canvas, chrome)
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
                : stripZoom(pane, chrome.stripHeight)
          return (
            <PaneView
              key={pane.id}
              pane={pane}
              index={index}
              zoom={paneZoom}
              url={project.startUrl}
              status={statuses[pane.id]}
              actionsWidth={chrome.paneActions}
              theme={chrome.theme}
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
  actionsWidth,
  theme,
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
  /** Screen pixels the header's own controls occupy, measured off their tokens. */
  actionsWidth: number
  theme: AppTheme
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
      <PaneHeader
        pane={pane}
        index={index}
        width={drawn.width}
        status={status}
        actionsWidth={actionsWidth}
        theme={theme}
      />
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
 * claim width the pane does not have. What it still says at that width is the degradation
 * ladder's answer ([ADR-0010]), and the ladder is a pure function of the drawn width —
 * not of the zoom, because Focus draws its panes at several at once.
 *
 * Everything it says is said against what is actually emulated rather than what the pane
 * declares: a field whose capability is not in force is marked and keeps its number, so a
 * pane cannot quietly claim a viewport the override was refused for.
 *
 * The size fields, rotate and remove are the developer's end of `panes.resize`,
 * `panes.rotate` and `panes.remove` — no route here the terminal cannot reach
 * ([ADR-0005]).
 */
function PaneHeader({
  pane,
  index,
  width,
  status,
  actionsWidth,
  theme
}: {
  pane: Pane
  index: number
  /** Screen pixels: what this pane is drawn at, which is what the ladder is keyed on. */
  width: number
  status: PaneStatus | undefined
  actionsWidth: number
  theme: AppTheme
}): React.JSX.Element {
  const tier = paneHeaderTier(width)
  const silent = paneHeaderIsSilent(tier)
  const degraded = status?.degraded ?? []
  const errors = status?.errors ?? 0
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
      // Exactly the pane's drawn width and no more: the clipping is what binds the header
      // to the pane, and a header wider than its pane would claim ground we do not own.
      style={{ width }}
      data-testid="pane-header"
      data-tier={PANE_HEADER_TIERS.indexOf(tier)}
      // Everything the ladder took away is still here, which is what makes shedding it safe.
      title={describePane(pane, errors, reasons)}
    >
      <PaneTab pane={pane} index={index} carriesScheme={!tier.shows.scheme} theme={theme} />
      {tier.shows.name && (
        <span
          className="min-w-0 truncate font-mono text-[length:var(--bp-text-micro)] whitespace-nowrap text-[color:var(--bp-ink)]"
          data-testid="pane-name"
        >
          {pane.name}
        </span>
      )}
      <PaneSize pane={pane} tier={tier} status={status} onResize={resize} />
      {tier.shows.scheme && <PaneScheme pane={pane} status={status} />}
      {message !== null && !silent && (
        <span
          role="alert"
          data-testid="pane-action-error"
          title={message}
          className="min-w-0 truncate font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-error)]"
        >
          {message}
        </span>
      )}
      {degraded.length > 0 && !silent && (
        <span
          className="flex-none font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-warn)]"
          data-testid="pane-degraded"
          title={reasons}
        >
          ⚠
        </span>
      )}
      <div className="ml-auto flex flex-none items-center gap-[var(--bp-space-1)]">
        {paneHeaderHasActions(width, actionsWidth) && (
          <>
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
          </>
        )}
        {/* The last thing standing beside the colour tab: at every tier, a pane with
            errors says so, because that is what makes a narrow pane worth looking at. */}
        {errors > 0 && (
          <span
            className="flex-none rounded-[var(--bp-radius-xs)] bg-[var(--bp-error)] px-[var(--bp-space-2)] py-[var(--bp-space-1)] font-mono text-[length:var(--bp-text-micro)] leading-none font-medium tabular-nums text-[color:var(--bp-pane-ink)]"
            data-testid="pane-errors"
            title={`${describeErrors(errors)} in this pane`}
          >
            {errors}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The pane's identity, in its palette colour and nothing else. Once the ladder has taken
 * the scheme glyph away the tab carries the scheme too, splitting to half-tone when the
 * pane is rendering the page in something other than the app's own appearance — which is
 * the one thing about a pane too narrow to say anything that is still worth saying.
 */
function PaneTab({
  pane,
  index,
  carriesScheme,
  theme
}: {
  pane: Pane
  index: number
  carriesScheme: boolean
  theme: AppTheme
}): React.JSX.Element {
  const colour = paneColorVar(index)
  const split = carriesScheme && schemeDiffersFromApp(pane.colorScheme, theme)
  return (
    <span
      className="h-[var(--bp-pane-tab-h)] w-[var(--bp-pane-tab-w)] flex-none rounded-r-[var(--bp-radius-xs)]"
      style={{
        background: split
          ? `linear-gradient(to bottom, ${colour} 50%, var(--bp-chrome-sunken) 50%)`
          : colour
      }}
      data-testid="pane-tab"
      data-split={split ? 'true' : undefined}
      title={split ? `${pane.name}: ${pane.colorScheme}, where the app is ${theme}` : pane.name}
    />
  )
}

/** Everything the header could say, for the tiers where it cannot say it. */
function describePane(pane: Pane, errors: number, reasons: string): string {
  const lines = [
    `${pane.name} ${pane.width}×${pane.height} ${formatDpr(pane.dpr)} ${pane.colorScheme}`
  ]
  if (errors > 0) lines.push(describeErrors(errors))
  if (reasons) lines.push(reasons)
  return lines.join('\n')
}

/**
 * The pane's declared size, typed, and the DPR beside it. Each field shows what the pane
 * declares until it is edited, and commits only itself, so committing a width can never
 * carry a height the pane no longer has.
 *
 * Both are the device metrics override's to make true, so both are marked with its state:
 * a number the guest never accepted is shown as a number the guest never accepted.
 */
function PaneSize({
  pane,
  tier,
  status,
  onResize
}: {
  pane: Pane
  tier: PaneHeaderTier
  status: PaneStatus | undefined
  onResize(size: { width: number } | { height: number }): Promise<void>
}): React.JSX.Element | null {
  if (!tier.shows.width) return null
  const state = paneFieldState(status, 'viewport')

  return (
    <span
      className="flex flex-none items-center font-mono text-[length:var(--bp-text-micro)]"
      style={{ color: fieldTone(state) }}
      title={describeFieldState('viewport', state)}
      data-emulation={state}
    >
      <SizeInput
        label="Width"
        pane={pane.id}
        declared={pane.width}
        onCommit={(width) => void onResize({ width })}
      />
      {tier.shows.height && (
        <>
          ×
          <SizeInput
            label="Height"
            pane={pane.id}
            declared={pane.height}
            onCommit={(height) => void onResize({ height })}
          />
        </>
      )}
      {tier.shows.dpr && <span data-testid="pane-dpr">{formatDpr(pane.dpr)}</span>}
    </span>
  )
}

/**
 * The scheme the pane is rendering the page in, as a glyph. Marked when the override is
 * not in force, which is the case the glyph exists for: a pane showing ☾ while the page
 * is still in light is the lie the header is meant to prevent.
 */
function PaneScheme({
  pane,
  status
}: {
  pane: Pane
  status: PaneStatus | undefined
}): React.JSX.Element {
  const state = paneFieldState(status, 'scheme')
  return (
    <span
      className="flex-none font-mono text-[length:var(--bp-text-micro)]"
      style={{ color: fieldTone(state) }}
      data-testid="pane-scheme"
      data-scheme={pane.colorScheme}
      data-emulation={state}
      title={`${pane.colorScheme} — ${describeFieldState('scheme', state)}`}
    >
      {schemeGlyph(pane.colorScheme)}
    </span>
  )
}

/**
 * What a field's colour says about the thing behind it. Applied is the quiet case; a
 * refused override is a rim-and-header event and reads as one.
 */
const FIELD_TONE: Readonly<Record<CapabilityState, string>> = {
  applied: 'var(--bp-ink-muted)',
  pending: 'var(--bp-ink-faint)',
  failed: 'var(--bp-warn)'
}

function fieldTone(state: CapabilityState): string {
  return FIELD_TONE[state]
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
