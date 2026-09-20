import { Button } from '@renderer/components/ui/button'

export default function App(): React.JSX.Element {
  return (
    <div className="bg-background text-foreground flex h-screen items-center justify-center gap-3">
      <span className="font-mono text-[13px]">breakpoint</span>
      <Button size="sm" variant="outline">
        scaffold
      </Button>
    </div>
  )
}
