import { Button } from '@renderer/components/ui/button'
import { useConsole } from '@renderer/hooks/use-console'
import { useRepl } from '@renderer/hooks/use-repl'
import { useVirtualizer } from '@tanstack/react-virtual'
import { BanIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { aboveFloor, type ConsoleDisplay } from '../../../shared/console-floor'
import {
  anchorAt,
  collapseConsole,
  consoleGroupRow,
  consoleLines,
  consolePanes,
  consoleRow,
  consoleRowHeight,
  filterConsole,
  formatTime,
  isAtBottom,
  isFiltering,
  NO_CONSOLE_FILTER,
  toggleInSet,
  isExpandable,
  isExpanded,
  scrollTarget,
  shownBadges,
  type ConsoleAnchor,
  type ConsoleFilter,
  type ConsoleGroup,
  type ConsoleLine,
  type ConsolePaneBadge,
  type ConsolePanes,
  type ConsoleRow
} from '../../../shared/console-rows'
import { CONSOLE_LEVELS, type ConsoleLevel } from '../../../shared/event-log'
import {
  evaluationLevel,
  mergeLines,
  replLines,
  stepHistory,
  type ReplLine
} from '../../../shared/repl'
import { paneColorVar } from '../../../shared/pane-palette'
import type { Pane } from '../../../shared/project'
import type { RouteParams } from '../../../shared/routes'

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
 *
 * Filtered by pane, level and text, before collapsing, so a row carries only the badges
 * of panes still in view. A filter changes what this window draws and nothing else.
 *
 * Clear sets the display floor ([ADR-0022]): entries at or below it are not drawn, and the
 * log, every other reader of it and every pane's error count are untouched. The floor is
 * the snapshot's, so a reloaded window draws from where it was cleared.
 */
export function ConsoleView({
  panes,
  display
}: {
  panes: readonly Pane[]
  /** The display floor and preserve-log, as the snapshot carries them. */
  display: ConsoleDisplay
}): React.JSX.Element {
  const { history, ...state } = useConsole()
  const entries = useMemo(
    () => aboveFloor(history.entries, display.floor),
    [history.entries, display.floor]
  )
  const lookup = useMemo(() => consolePanes(panes), [panes])
  /** This window's filter: what it shows, and nothing else ([#76]). */
  const [filter, setFilter] = useState<ConsoleFilter>(NO_CONSOLE_FILTER)
  /** Why the last Clear or preserve-log change was refused, if it was. */
  const [refused, setRefused] = useState<string | null>(null)
  const inView = useMemo(() => filterConsole(entries, filter), [entries, filter])
  const groups = useMemo(() => collapseConsole(inView), [inView])
  /** The cursors of the rows the reader expanded; a row is open while any entry of it is. */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const repl = useRepl()
  const followFloor = repl.followFloor
  useEffect(() => followFloor(display.floor), [followFloor, display.floor])
  const asked = useMemo(() => replLines(repl.exchanges, filter), [repl.exchanges, filter])
  const lines = useMemo(
    () => mergeLines<ConsoleLine, ReplLine>(consoleLines(groups, expanded), asked),
    [groups, expanded, asked]
  )
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

  async function call<N extends 'app.clearConsole' | 'app.setPreserveLog'>(
    route: N,
    params: RouteParams<N>
  ): Promise<void> {
    try {
      const response = await window.breakpoint.invoke(route, params)
      setRefused(response.ok ? null : response.error.message)
    } catch (error) {
      setRefused(error instanceof Error ? error.message : String(error))
    }
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
      <ReplPrompt
        panes={panes}
        repl={repl}
        onEvaluate={(expression, pane) => {
          // Sending is reading: follow the answer down, as the console a developer knows does.
          anchor.current = null
          repl.evaluate(expression, pane, history.cursor)
        }}
      />
      <ConsoleFilterBar
        panes={panes}
        filter={filter}
        onChange={setFilter}
        preserveLog={display.preserveLog}
        onClear={() => void call('app.clearConsole', undefined)}
        onPreserveLog={(preserveLog) => void call('app.setPreserveLog', { preserveLog })}
      />
      {(state.status === 'error' || refused !== null) && (
        <p
          role="alert"
          data-testid="console-error"
          className="flex-none truncate px-[var(--bp-space-3)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
        >
          {refused ?? (state.status === 'error' ? state.message : null)}
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
  line: ConsoleLine | ReplLine
  panes: ConsolePanes
  expanded: ReadonlySet<number>
  onToggle: (group: ConsoleGroup) => void
  top: number
}): React.JSX.Element {
  if (line.kind === 'input' || line.kind === 'result') {
    return <ReplLineView line={line} panes={panes} top={top} />
  }
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

/** Levels as the filter offers them, most severe first, which is the order a reader narrows in. */
const FILTER_LEVELS: readonly ConsoleLevel[] = [...CONSOLE_LEVELS].reverse()

const CHIP =
  'inline-flex h-[var(--bp-chip-h)] flex-none items-center gap-[var(--bp-space-2)] rounded-[var(--bp-radius-xs)] border px-[var(--bp-space-2)] font-mono text-[length:var(--bp-text-micro)] cursor-pointer'
const CHIP_ON =
  'border-[var(--bp-accent)] bg-[var(--bp-accent-wash)] text-[color:var(--bp-accent-ink)]'
const CHIP_OFF = 'border-[var(--bp-border)] bg-transparent text-[color:var(--bp-ink-muted)]'

/**
 * The filter strip beneath the list, as the prototype places it: a text field, then a chip
 * per level and per pane, each on until turned off. With everything on a dimension does not
 * filter at all, so an entry from a pane since removed still shows until panes are narrowed.
 */
function ConsoleFilterBar({
  panes,
  filter,
  onChange,
  preserveLog,
  onClear,
  onPreserveLog
}: {
  panes: readonly Pane[]
  filter: ConsoleFilter
  onChange: (filter: ConsoleFilter) => void
  preserveLog: boolean
  onClear: () => void
  onPreserveLog: (preserveLog: boolean) => void
}): React.JSX.Element {
  const paneIds = panes.map((pane) => pane.id)
  return (
    <div
      className="flex h-[var(--bp-row)] flex-none items-center gap-[var(--bp-space-2)] overflow-hidden border-t border-[var(--bp-border)] px-[var(--bp-space-3)] font-mono text-[length:var(--bp-text-sm)]"
      data-testid="console-filters"
      data-filtering={isFiltering(filter)}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        title="Clear console"
        aria-label="Clear console"
        data-testid="console-clear"
        onClick={onClear}
      >
        <BanIcon />
      </Button>
      <span className="flex-none text-[color:var(--bp-accent)]" aria-hidden>
        ›
      </span>
      <input
        type="search"
        value={filter.text}
        onChange={(event) => onChange({ ...filter, text: event.target.value })}
        placeholder="filter…"
        aria-label="Filter messages"
        data-testid="console-filter-text"
        className="h-full min-w-0 flex-1 bg-transparent text-[color:var(--bp-ink)] outline-none placeholder:text-[color:var(--bp-ink-faint)]"
      />
      <span role="group" aria-label="Levels" className="flex flex-none gap-[var(--bp-space-1)]">
        {FILTER_LEVELS.map((level) => {
          const on = filter.levels === null || filter.levels.has(level)
          return (
            <button
              key={level}
              type="button"
              aria-pressed={on}
              className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
              onClick={() =>
                onChange({ ...filter, levels: toggleInSet(filter.levels, level, FILTER_LEVELS) })
              }
              data-testid="console-filter-level"
              data-level={level}
            >
              {level}
            </button>
          )
        })}
      </span>
      <span
        className="h-[var(--bp-badge-h)] w-[var(--bp-stroke)] flex-none bg-[var(--bp-border)]"
        aria-hidden
      />
      <span
        role="group"
        aria-label="Panes"
        className="flex min-w-0 flex-none gap-[var(--bp-space-1)] overflow-hidden"
      >
        {panes.map((pane, index) => {
          const on = filter.panes === null || filter.panes.has(pane.id)
          return (
            <button
              key={pane.id}
              type="button"
              aria-pressed={on}
              title={pane.name}
              className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
              onClick={() =>
                onChange({ ...filter, panes: toggleInSet(filter.panes, pane.id, paneIds) })
              }
              data-testid="console-filter-pane"
              data-pane={pane.id}
            >
              <span
                className="h-[var(--bp-pane-tab-h)] w-[var(--bp-pane-tab-w)] flex-none rounded-[var(--bp-radius-xs)]"
                style={{ background: paneColorVar(index) }}
                aria-hidden
              />
              {pane.name}
            </button>
          )
        })}
      </span>
      {isFiltering(filter) && (
        <button
          type="button"
          className={`${CHIP} ${CHIP_OFF}`}
          onClick={() => onChange(NO_CONSOLE_FILTER)}
          title="Clear filters"
          data-testid="console-filter-clear"
        >
          clear
        </button>
      )}
      <span
        className="h-[var(--bp-badge-h)] w-[var(--bp-stroke)] flex-none bg-[var(--bp-border)]"
        aria-hidden
      />
      <button
        type="button"
        aria-pressed={preserveLog}
        className={`${CHIP} ${preserveLog ? CHIP_ON : CHIP_OFF}`}
        onClick={() => onPreserveLog(!preserveLog)}
        title="Keep entries when the project navigates"
        data-testid="console-preserve-log"
      >
        preserve log
      </button>
    </div>
  )
}

/** The badge for a pane an answer came from, or that an expression was sent to. */
function paneBadge(pane: string, panes: ConsolePanes): ConsolePaneBadge {
  const known = panes.get(pane)
  return known
    ? { id: pane, label: known.name, color: known.index }
    : { id: pane, label: pane, color: null }
}

/**
 * A REPL line in the console's own columns, so an answer reads like a row: the expression
 * as sent, marked `›` and badged with where it went, then one answer per pane beneath it,
 * marked `‹` and badged with its pane, so answers from several widths line up to compare.
 */
function ReplLineView({
  line,
  panes,
  top
}: {
  line: ReplLine
  panes: ConsolePanes
  top: number
}): React.JSX.Element {
  const { exchange } = line
  if (line.kind === 'input') {
    const badges =
      exchange.pane === null
        ? [{ id: '', label: 'all', color: null }]
        : [paneBadge(exchange.pane, panes)]
    return (
      <div
        className={ROW}
        style={{ top, height: consoleRowHeight() }}
        data-testid="console-repl-input"
        data-pane={exchange.pane ?? ''}
        data-pending={exchange.results === null}
      >
        <span
          className="w-[var(--bp-console-level-w)] flex-none text-center text-[color:var(--bp-accent)]"
          aria-label="evaluated"
        >
          ›
        </span>
        <ReplBadges badges={badges} />
        <span className="w-[var(--bp-console-time-w)] flex-none text-[color:var(--bp-ink-faint)]">
          {formatTime(exchange.time)}
        </span>
        <span
          className="min-w-0 flex-1 truncate whitespace-nowrap text-[color:var(--bp-ink)]"
          title={exchange.expression}
          data-testid="console-message"
        >
          {exchange.expression}
        </span>
      </div>
    )
  }

  const { evaluation } = line
  const level = evaluationLevel(evaluation)
  return (
    <div
      className={`${ROW} ${LEVEL_WASH[level]}`}
      style={{ top, height: consoleRowHeight() }}
      data-testid="console-repl-result"
      data-pane={evaluation.pane}
      data-outcome={evaluation.outcome}
      data-level={level}
    >
      <span
        className={`w-[var(--bp-console-level-w)] flex-none text-center ${
          level === 'error' ? LEVEL_INK.error : 'text-[color:var(--bp-ink-faint)]'
        }`}
        aria-label={evaluation.outcome}
      >
        {level === 'error' ? LEVEL_GLYPH.error : '‹'}
      </span>
      <ReplBadges badges={[paneBadge(evaluation.pane, panes)]} />
      <span className="w-[var(--bp-console-time-w)] flex-none text-[color:var(--bp-ink-faint)]">
        {exchange.answered === null ? '' : formatTime(exchange.answered)}
      </span>
      <span
        className={`min-w-0 flex-1 truncate whitespace-nowrap ${
          level === 'error' ? 'text-[color:var(--bp-error)]' : 'text-[color:var(--bp-ink)]'
        }`}
        title={evaluation.text}
        data-testid="console-message"
      >
        {evaluation.text}
      </span>
    </div>
  )
}

function ReplBadges({ badges }: { badges: readonly ConsolePaneBadge[] }): React.JSX.Element {
  return (
    <span className="flex w-[var(--bp-console-pane-w)] flex-none gap-[var(--bp-space-1)] overflow-hidden">
      {badges.map((badge) => (
        <Badge
          key={badge.id}
          label={badge.label}
          title={badge.label}
          background={badge.color === null ? 'var(--bp-border-strong)' : paneColorVar(badge.color)}
          testId="console-pane-badge"
          pane={badge.id}
        />
      ))}
    </span>
  )
}

/**
 * Where an expression is typed: a chip per target — every pane, or one — then the prompt.
 * Enter evaluates, Up and Down step through what was evaluated before, and stepping off the
 * newest end gives back what was being typed.
 */
function ReplPrompt({
  panes,
  repl,
  onEvaluate
}: {
  panes: readonly Pane[]
  repl: ReturnType<typeof useRepl>
  onEvaluate: (expression: string, pane: string | null) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  // A pane removed since it was picked is not somewhere to send anything.
  const target = chosen !== null && panes.some((pane) => pane.id === chosen) ? chosen : null

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (text.trim() === '' || panes.length === 0) return
      onEvaluate(text, target)
      setText('')
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const step = stepHistory(repl.history, event.key === 'ArrowUp' ? 'back' : 'forward', text)
    if (!step) return
    event.preventDefault()
    repl.setHistory(step.history)
    setText(step.text)
  }

  const targets: { id: string | null; label: string; color: number | null }[] = [
    { id: null, label: 'all', color: null },
    ...panes.map((pane, index) => ({ id: pane.id, label: pane.name, color: index }))
  ]
  return (
    <div
      className="flex h-[var(--bp-row)] flex-none items-center gap-[var(--bp-space-2)] overflow-hidden border-t border-[var(--bp-border)] px-[var(--bp-space-3)] font-mono text-[length:var(--bp-text-sm)]"
      data-testid="console-repl"
    >
      <span
        role="radiogroup"
        aria-label="Evaluate in"
        className="flex min-w-0 flex-none gap-[var(--bp-space-1)] overflow-hidden"
      >
        {targets.map((each) => {
          const on = each.id === target
          return (
            <button
              key={each.id ?? ''}
              type="button"
              role="radio"
              aria-checked={on}
              title={each.id === null ? 'Evaluate in every pane' : `Evaluate in ${each.label}`}
              className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
              onClick={() => setChosen(each.id)}
              data-testid="console-repl-target"
              data-pane={each.id ?? ''}
            >
              {each.color !== null && (
                <span
                  className="h-[var(--bp-pane-tab-h)] w-[var(--bp-pane-tab-w)] flex-none rounded-[var(--bp-radius-xs)]"
                  style={{ background: paneColorVar(each.color) }}
                  aria-hidden
                />
              )}
              {each.label}
            </button>
          )
        })}
      </span>
      <span className="flex-none text-[color:var(--bp-accent)]" aria-hidden>
        ›
      </span>
      <input
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={panes.length === 0}
        placeholder={panes.length === 0 ? 'no panes to evaluate in' : 'evaluate…'}
        aria-label="Evaluate an expression"
        spellCheck={false}
        autoComplete="off"
        data-testid="console-repl-input-field"
        className="h-full min-w-0 flex-1 bg-transparent text-[color:var(--bp-ink)] outline-none placeholder:text-[color:var(--bp-ink-faint)]"
      />
    </div>
  )
}
