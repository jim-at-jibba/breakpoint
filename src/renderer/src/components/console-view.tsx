import { useConsole } from '@renderer/hooks/use-console'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  anchorAt,
  collapseConsole,
  consoleGroupRow,
  consoleLines,
  consolePanes,
  consoleRow,
  consoleRowHeight,
  isAtBottom,
  isExpandable,
  isExpanded,
  scrollTarget,
  shownBadges,
  type ConsoleAnchor,
  type ConsoleGroup,
  type ConsoleLine,
  type ConsolePaneBadge,
  type ConsolePanes,
  type ConsoleRow
} from '../../../shared/console-rows'
import type { ConsoleLevel } from '../../../shared/event-log'
import { paneColorVar } from '../../../shared/pane-palette'
import type { Pane } from '../../../shared/project'

/** Rows drawn beyond each edge of the viewport, so a fast scroll is never blank. */
const OVERSCAN = 20

/**
 * The Console tab: every console entry the log retains, collapsed ([ADR-0023]) so the same
 * message from several panes is one row carrying their badges, one fixed-height line per
 * row ([ADR-0024]), virtualised so only what is on screen is drawn. Clicking a row that
 * carries several panes expands it into one line per entry beneath it, each with its own
 * time and location, so the copies can be checked for really being identical.
 *
 * At the bottom it follows new entries. Scrolled up, it holds the line at the top of the
 * viewport where it is while entries arrive below and old ones are evicted above: the
 * scroll position is recomputed from that line's index before the frame is painted, so
 * nothing jumps. Lines have one height, so that position is arithmetic.
 */
export function ConsoleView({ panes }: { panes: readonly Pane[] }): React.JSX.Element {
  const { history, ...state } = useConsole()
  const entries = history.entries
  const lookup = useMemo(() => consolePanes(panes), [panes])
  const groups = useMemo(() => collapseConsole(entries), [entries])
  /** The cursors of the rows the reader expanded; a row is open while any entry of it is. */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const lines = useMemo(() => consoleLines(groups, expanded), [groups, expanded])
  const scroller = useRef<HTMLDivElement>(null)
  /** `null` is pinned to the bottom; otherwise the line the reader is holding. */
  const anchor = useRef<ConsoleAnchor | null>(null)
  const latest = useRef(lines)

  // The compiler skips this component rather than memoise the virtualiser's functions,
  // which is what the virtualiser needs: it re-renders on every scroll by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    // Exact rather than estimated: no line is ever measured.
    estimateSize: () => consoleRowHeight(),
    getItemKey: (index) => lines[index].key,
    overscan: OVERSCAN
  })

  useLayoutEffect(() => {
    latest.current = lines
    const element = scroller.current
    if (!element) return
    const target = scrollTarget(lines, anchor.current, element.clientHeight)
    if (Math.round(element.scrollTop) !== Math.round(target)) virtualizer.scrollToOffset(target)
  }, [lines, virtualizer])

  function onScroll(): void {
    const element = scroller.current
    if (!element) return
    anchor.current = isAtBottom(element.scrollTop, element.scrollHeight, element.clientHeight)
      ? null
      : anchorAt(latest.current, element.scrollTop)
  }

  function toggle(group: ConsoleGroup): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (isExpanded(group, current)) for (const entry of group.entries) next.delete(entry.cursor)
      else next.add(group.cursor)
      return next
    })
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
            <ConsoleLineView
              key={item.key}
              line={lines[item.index]}
              panes={lookup}
              expanded={expanded}
              onToggle={toggle}
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

const ROW =
  'absolute left-0 flex w-full items-center gap-[var(--bp-space-3)] overflow-hidden border-b border-[var(--bp-border)] px-[var(--bp-space-3)] font-mono text-[length:var(--bp-text-sm)]'

function ConsoleLineView({
  line,
  panes,
  expanded,
  onToggle,
  top
}: {
  line: ConsoleLine
  panes: ConsolePanes
  expanded: ReadonlySet<number>
  onToggle: (group: ConsoleGroup) => void
  top: number
}): React.JSX.Element {
  if (line.kind === 'entry') {
    const row = consoleRow(line.entry, panes)
    return (
      <div
        className={`${ROW} bg-[var(--bp-chrome-sunken)]`}
        style={{ top, height: consoleRowHeight() }}
        data-testid="console-entry"
        data-cursor={row.key}
        data-row={line.cursor}
        data-level={row.level}
      >
        <Columns row={row} badges={[row.pane]} />
      </div>
    )
  }

  const { group } = line
  const row = consoleGroupRow(group, panes)
  const expandable = isExpandable(group)
  const open = isExpanded(group, expanded)
  const toggle = (): void => onToggle(group)
  return (
    <div
      className={`${ROW} ${LEVEL_WASH[row.level]}${expandable ? ' cursor-pointer' : ''}`}
      style={{ top, height: consoleRowHeight() }}
      data-testid="console-row"
      data-cursor={row.key}
      data-level={row.level}
      data-panes={row.badges.map((badge) => badge.id).join(' ')}
      {...(expandable && {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: toggle,
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }
      })}
    >
      <Columns row={row} badges={row.badges} />
    </div>
  )
}

function Columns({
  row,
  badges
}: {
  row: ConsoleRow
  badges: readonly ConsolePaneBadge[]
}): React.JSX.Element {
  const { shown, more } = shownBadges(badges)
  return (
    <>
      <span
        className={`w-[var(--bp-console-level-w)] flex-none text-center text-[length:var(--bp-text-micro)] ${LEVEL_INK[row.level]}`}
        aria-label={row.level}
      >
        {LEVEL_GLYPH[row.level]}
      </span>
      <span className="flex w-[var(--bp-console-pane-w)] flex-none gap-[var(--bp-space-1)] overflow-hidden">
        {shown.map((badge) => (
          <Badge
            key={badge.id}
            label={badge.label}
            title={badge.label}
            background={
              badge.color === null ? 'var(--bp-border-strong)' : paneColorVar(badge.color)
            }
            testId="console-pane-badge"
            pane={badge.id}
          />
        ))}
        {more.length > 0 && (
          <Badge
            label={`+${more.length}`}
            title={more.map((badge) => badge.label).join(', ')}
            background="var(--bp-border-strong)"
            testId="console-more-badge"
          />
        )}
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
    </>
  )
}

function Badge({
  label,
  title,
  background,
  testId,
  pane
}: {
  label: string
  title: string
  background: string
  testId: string
  pane?: string
}): React.JSX.Element {
  return (
    <span
      className="inline-flex h-[var(--bp-badge-h)] max-w-full min-w-0 items-center truncate rounded-[var(--bp-radius-xs)] px-[var(--bp-space-2)] text-[length:var(--bp-text-micro)] font-medium text-[color:var(--bp-pane-ink)]"
      style={{ background }}
      title={title}
      data-testid={testId}
      data-pane={pane}
    >
      {label}
    </span>
  )
}
