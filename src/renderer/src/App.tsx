import { Button } from '@renderer/components/ui/button'

// Placeholder. Exists only to prove the shell and the token layer: the toolbar
// strip is the window's drag region and clears the traffic lights, and the body
// shows the chrome ground, Inter, the mono stack, a pane identity hue and a Base
// UI component picking up --primary. Replaced by the real toolbar and canvas.
export default function App(): React.JSX.Element {
  return (
    <div className="flex h-screen flex-col">
      <header
        className="bp-drag border-border flex shrink-0 items-center border-b"
        style={{ height: 'var(--bp-toolbar-h)', paddingLeft: 88 }}
      >
        <span className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
          toolbar
        </span>
      </header>
      <main className="bg-background text-foreground flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className="size-2 rounded-xs"
            style={{ background: 'var(--bp-pane-1)' }}
            aria-hidden
          />
          <span className="font-mono text-[length:var(--bp-text-lg)]">breakpoint</span>
        </div>
        <Button size="sm" variant="outline">
          scaffold
        </Button>
      </main>
    </div>
  )
}
