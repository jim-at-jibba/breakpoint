import { Button } from '@renderer/components/ui/button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@renderer/components/ui/resizable'
import { PanelBottomIcon, PanelRightIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import {
  CANVAS_MIN_SIZE,
  PANEL_MIN_SIZE,
  panelSize,
  type PanelSetting,
  type PanelState
} from '../../../shared/panel'

/**
 * The tabs the panel can show. One today; Phase 4's Layout tab and the rest join this
 * list rather than a second panel, which is why the bar exists before it has a choice to
 * offer ([#49]).
 */
const TABS = [{ id: 'console', label: 'Console' }] as const

type TabId = (typeof TABS)[number]['id']

/**
 * The canvas and the panel docked to it, below or beside. The canvas gives up exactly
 * the space the panel takes, and has the whole window back when the panel is hidden.
 *
 * The arrangement is the snapshot's, not this component's: `app.setPanel` is the only
 * thing that changes it, so a resize made here, a side changed from a terminal and a
 * restart all arrive the same way. The library holds the size while a drag is under
 * way; what is kept is where the pointer was released.
 *
 * The canvas is always the group's first child, at the same place in the tree whichever
 * way the panel docks and whether or not it shows, so docking and hiding never remount
 * a pane's guest.
 */
export function CanvasWithPanel({
  panel,
  children
}: {
  panel: PanelState
  children: ReactNode
}): React.JSX.Element {
  const panelRef = usePanelRef()
  const size = panelSize(panel)
  const [message, setMessage] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('console')
  const version = useRef(0)

  // The snapshot moved under the drawn panel: a side changed, a size set from a
  // terminal, a resize this window made being confirmed. Only the first two move it.
  useEffect(() => {
    const handle = panelRef.current
    if (!panel.visible || !handle) return
    // A panel just shown has no layout in its group until the group's next pass, and
    // asking it its size throws. It needs nothing from here: `defaultSize` places it.
    let drawn: number
    try {
      drawn = handle.getSize().inPixels
    } catch {
      return
    }
    if (Math.round(drawn) !== size) handle.resize(size)
  }, [panelRef, panel.side, panel.visible, size])

  async function arrange(setting: PanelSetting): Promise<void> {
    const mine = ++version.current
    try {
      const response = await window.breakpoint.invoke('app.setPanel', setting)
      if (version.current === mine) setMessage(response.ok ? null : response.error.message)
    } catch (error) {
      if (version.current === mine) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const bottom = panel.side === 'bottom'

  return (
    <ResizablePanelGroup
      orientation={bottom ? 'vertical' : 'horizontal'}
      className="min-h-0 flex-1"
      data-testid="panel-group"
      data-side={panel.side}
      onLayoutChanged={(_layout, meta) => {
        // Only a drag or a key is the developer resizing. A window growing, the panel
        // being shown, and the library settling at mount are not choices to keep.
        if (!meta.isUserInteraction || !panelRef.current) return
        const drawn = Math.round(panelRef.current.getSize().inPixels)
        if (drawn !== size) void arrange({ size: drawn })
      }}
    >
      <ResizablePanel
        id="canvas"
        minSize={CANVAS_MIN_SIZE}
        className="flex flex-col"
        data-testid="canvas-region"
      >
        {children}
      </ResizablePanel>
      {panel.visible && (
        <>
          <ResizableHandle data-testid="panel-handle" />
          <ResizablePanel
            id="panel"
            panelRef={panelRef}
            defaultSize={size}
            minSize={PANEL_MIN_SIZE}
            groupResizeBehavior="preserve-pixel-size"
            className="flex flex-col bg-[var(--bp-chrome)]"
            data-testid="panel"
          >
            <PanelTabBar
              tab={tab}
              side={panel.side}
              message={message}
              onTab={setTab}
              onMove={() => void arrange({ side: bottom ? 'right' : 'bottom' })}
              onHide={() => void arrange({ visible: false })}
            />
            <div
              role="tabpanel"
              id={`panel-tab-${tab}`}
              aria-labelledby={`panel-tab-${tab}-label`}
              className="min-h-0 flex-1 overflow-auto"
              data-testid="panel-body"
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  )
}

function PanelTabBar({
  tab,
  side,
  message,
  onTab,
  onMove,
  onHide
}: {
  tab: TabId
  side: PanelState['side']
  message: string | null
  onTab: (tab: TabId) => void
  onMove: () => void
  onHide: () => void
}): React.JSX.Element {
  const other = side === 'bottom' ? 'right' : 'bottom'
  return (
    <div
      className="flex flex-none items-stretch gap-[var(--bp-space-3)] border-b border-[var(--bp-border)] pr-[var(--bp-space-2)]"
      style={{ height: 'var(--bp-tabbar-h)' }}
    >
      <div role="tablist" aria-label="Panel" className="flex items-stretch">
        {TABS.map(({ id, label }) => {
          const selected = id === tab
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`panel-tab-${id}-label`}
              aria-selected={selected}
              aria-controls={`panel-tab-${id}`}
              data-testid="panel-tab"
              onClick={() => onTab(id)}
              className={`flex items-center gap-[var(--bp-space-2)] border-b-[length:var(--bp-stroke-strong)] px-[var(--bp-space-4)] text-[length:var(--bp-text-sm)] transition-colors duration-[var(--bp-dur-fast)] ${
                selected
                  ? 'border-[var(--bp-accent)] text-[color:var(--bp-ink)]'
                  : 'border-transparent text-[color:var(--bp-ink-muted)] hover:text-[color:var(--bp-ink)]'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
      {message !== null && (
        <span
          role="alert"
          data-testid="panel-error"
          className="self-center truncate text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
        >
          {message}
        </span>
      )}
      <div className="ml-auto flex items-center gap-[var(--bp-space-1)]">
        <Button
          size="icon-xs"
          variant="ghost"
          title={`Dock ${other}`}
          aria-label={`Dock ${other}`}
          data-testid="panel-side-toggle"
          onClick={onMove}
        >
          {other === 'right' ? <PanelRightIcon /> : <PanelBottomIcon />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Hide panel"
          aria-label="Hide panel"
          data-testid="panel-hide"
          onClick={onHide}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  )
}

/**
 * The toolbar's way back to a hidden panel, and the other way out of a showing one. In
 * the toolbar rather than the panel because a hidden panel has nowhere of its own to
 * draw a button.
 */
export function PanelToggle({
  panel,
  onToggle
}: {
  panel: PanelState
  onToggle: (visible: boolean) => void
}): React.JSX.Element {
  const label = panel.visible ? 'Hide panel' : 'Show panel'
  return (
    <Button
      size="icon-sm"
      variant="outline"
      title={label}
      aria-label={label}
      aria-pressed={panel.visible}
      data-testid="panel-toggle"
      onClick={() => onToggle(!panel.visible)}
    >
      {panel.side === 'bottom' ? <PanelBottomIcon /> : <PanelRightIcon />}
    </Button>
  )
}
