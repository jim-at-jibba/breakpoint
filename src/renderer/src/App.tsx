import { Button } from '@renderer/components/ui/button'

// Placeholder. Exists only to prove the token layer reaches the renderer:
// chrome ground, Inter, the mono stack, a pane identity hue and a Base UI
// component picking up --primary. Replaced by the real toolbar and canvas.
export default function App(): React.JSX.Element {
  return (
    <div className="bg-background text-foreground flex h-screen flex-col items-center justify-center gap-4">
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
    </div>
  )
}
