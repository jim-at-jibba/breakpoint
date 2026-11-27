import { useConsole } from '@renderer/hooks/use-console'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ConsoleEntry } from '../../../shared/console-feed'
import {
  anchorAt,
  consolePanes,
  consoleRow,
  consoleRowHeight,
  isAtBottom,
  scrollTarget,
  type ConsoleAnchor,
  type ConsolePanes,
  type ConsoleRow
} from '../../../shared/console-rows'
import type { ConsoleLevel } from '../../../shared/event-log'
import { paneColorVar } from '../../../shared/pane-palette'
import type { Pane } from '../../../shared/project'

/** Rows drawn beyond each edge of the viewport, so a fast scroll is never blank. */
const OVERSCAN = 20

/**
 * The Console tab: every console entry the log retains, one fixed-height row each
 * ([ADR-0024]), virtualised so only what is on screen is drawn.
 *
 * At the bottom it follows new entries. Scrolled up, it holds the entry at the top of the
 * viewport where it is while entries arrive below and old ones are evicted above: the
 * scroll position is recomputed from that entry's index before the frame is painted, so
 * nothing jumps. Rows have one height, so that position is arithmetic.
 */
export function ConsoleView({ panes }: { panes: readonly Pane[] }): React.JSX.Element {
  const { history, ...state } = useConsole()
  const entries = history.entries
  const lookup = useMemo(() => consolePanes(panes), [panes])
  const scroller = useRef<HTMLDivElement>(null)
  /** `null` is pinned to the bottom; otherwise the entry the reader is holding. */
  const anchor = useRef<ConsoleAnchor | null>(null)
  const latest = useRef(entries)

  // The compiler skips this component rather than memoise the virtualiser's functions,
  // which is what the virtualiser needs: it re-renders on every scroll by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    // Exact rather than estimated: no row is ever measured.
    estimateSize: () => consoleRowHeight(),
    getItemKey: (index) => entries[index].cursor,
    overscan: OVERSCAN
  })

  useLayoutEffect(() => {
    latest.current = entries
    const element = scroller.current
    if (!element) return
    const target = scrollTarget(entries, anchor.current, element.clientHeight)
    if (Math.round(element.scrollTop) !== Math.round(target)) virtualizer.scrollToOffset(target)
  }, [entries, virtualizer])

  function onScroll(): void {
    const element = scroller.current
    if (!element) return
    anchor.current = isAtBottom(element.scrollTop, element.scrollHeight, element.clientHeight)
      ? null
      : anchorAt(latest.current, element.scrollTop)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="console">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        data-testid="console-scroller"
        data-status={state.status}
        role="log"
        aria-label="Console"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <ConsoleRowView
              key={item.key}
              entry={entries[item.index]}
              panes={lookup}
              top={item.start}
            />
          ))}
        </div>
      </div>
      {state.status === 'error' && (
        <p
          role="alert"
          data-testid="console-error"
          className="flex-none truncate px-[var(--bp-space-3)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
        >
          {state.message}
        </p>
      )}
    </div>
  )
}

const LEVEL_GLYPH: Readonly<Record<ConsoleLevel, string>> = {
  error: '✕',
  warn: '!',
  info: 'i',
  log: '·',
  debug: '·'
}

const LEVEL_INK: Readonly<Record<ConsoleLevel, string>> = {
  error: 'text-[color:var(--bp-error)]',
  warn: 'text-[color:var(--bp-warn)]',
  info: 'text-[color:var(--bp-info)]',
  log: 'text-[color:var(--bp-ink-faint)]',
  debug: 'text-[color:var(--bp-ink-faint)]'
}

const LEVEL_WASH: Readonly<Record<ConsoleLevel, string>> = {
  error: 'bg-[var(--bp-error-wash)]',
  warn: 'bg-[var(--bp-warn-wash)]',
  info: '',
  log: '',
  debug: ''
}

function ConsoleRowView({
  entry,
  panes,
  top
}: {
  entry: ConsoleEntry
  panes: ConsolePanes
  top: number
}): React.JSX.Element {
  const row: ConsoleRow = consoleRow(entry, panes)
  return (
    <div
      className={`absolute left-0 flex w-full items-center gap-[var(--bp-space-3)] overflow-hidden border-b border-[var(--bp-border)] px-[var(--bp-space-3)] font-mono text-[length:var(--bp-text-sm)] ${LEVEL_WASH[row.level]}`}
      style={{ top, height: consoleRowHeight() }}
      data-testid="console-row"
      data-cursor={row.key}
      data-level={row.level}
    >
      <span
        className={`w-[var(--bp-console-level-w)] flex-none text-center text-[length:var(--bp-text-micro)] ${LEVEL_INK[row.level]}`}
        aria-label={row.level}
      >
        {LEVEL_GLYPH[row.level]}
      </span>
      <span className="flex w-[var(--bp-console-pane-w)] flex-none gap-[var(--bp-space-1)] overflow-hidden">
        <span
          className="inline-flex h-[var(--bp-badge-h)] max-w-full items-center truncate rounded-[var(--bp-radius-xs)] px-[var(--bp-space-2)] text-[length:var(--bp-text-micro)] font-medium text-[color:var(--bp-pane-ink)]"
          style={{
            background:
              row.pane.color === null ? 'var(--bp-border-strong)' : paneColorVar(row.pane.color)
          }}
          title={row.pane.label}
          data-testid="console-pane-badge"
          data-pane={row.pane.id}
        >
          {row.pane.label}
        </span>
      </span>
      <span className="w-[var(--bp-console-time-w)] flex-none text-[color:var(--bp-ink-faint)]">
        {row.time}
      </span>
      <span
        className={`min-w-0 flex-1 truncate whitespace-nowrap ${
          row.level === 'error' ? 'text-[color:var(--bp-error)]' : 'text-[color:var(--bp-ink)]'
        }`}
        title={row.message}
        data-testid="console-message"
      >
        {row.message}
      </span>
      {row.location !== null && (
        <span
          className="max-w-[40%] flex-none truncate text-[color:var(--bp-ink-faint)]"
          title={row.locationTitle ?? undefined}
          data-testid="console-location"
        >
          {row.location}
        </span>
      )}
    </div>
  )
}
