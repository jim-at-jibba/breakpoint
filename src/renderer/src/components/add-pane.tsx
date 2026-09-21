import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useState } from 'react'
import { isPaneDimension } from '../../../shared/panes'
import type { Preset } from '../../../shared/presets'
import type { PaneCreation } from '../../../shared/routes'

/**
 * Adding a pane: the toolbar's `+`, over a list of the presets and a custom size.
 *
 * Presets are read when the popover opens rather than held, because the file is the
 * developer's to edit while the app runs — what is listed here is what the next pane
 * will actually be resolved from ([ADR-0011]).
 */
export function AddPane(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<Preset[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function load(): Promise<void> {
    const response = await window.breakpoint.invoke('presets.list')
    if (response.ok) {
      setPresets(response.data.presets)
      setMessage(null)
      return
    }
    setPresets([])
    setMessage(response.error.message)
  }

  async function add(creation: PaneCreation): Promise<void> {
    const response = await window.breakpoint.invoke('panes.add', creation)
    if (!response.ok) {
      setMessage(response.error.message)
      return
    }
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (next) {
          setMessage(null)
          void load()
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="outline"
            title="Add pane"
            aria-label="Add pane"
            data-testid="add-pane"
          >
            +
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-64 gap-[var(--bp-space-2)] rounded-[var(--bp-radius-md)] bg-[var(--bp-chrome-raised)] p-[var(--bp-space-2)]"
        data-testid="add-pane-menu"
      >
        <div className="flex flex-col">
          {presets === null ? (
            <span className="px-[var(--bp-space-2)] py-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
              Reading presets…
            </span>
          ) : (
            presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid="add-pane-preset"
                data-preset={preset.id}
                onClick={() => void add({ preset: preset.id })}
                className="flex h-[var(--bp-row-md)] items-center gap-[var(--bp-space-3)] rounded-[var(--bp-radius-sm)] px-[var(--bp-space-2)] text-left text-[length:var(--bp-text-base)] text-[color:var(--bp-ink)] hover:bg-[var(--bp-hover)]"
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="flex-none font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
                  {preset.width}×{preset.height} @{preset.dpr}x
                </span>
              </button>
            ))
          )}
        </div>
        <CustomSize onAdd={add} />
        {message !== null && (
          <span
            role="alert"
            className="px-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
          >
            {message}
          </span>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A pane at a size the developer types, which belongs to no preset. */
function CustomSize({
  onAdd
}: {
  onAdd(creation: PaneCreation): Promise<void>
}): React.JSX.Element {
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const size = { width: Number(width), height: Number(height) }
  const valid =
    width !== '' && height !== '' && isPaneDimension(size.width) && isPaneDimension(size.height)

  return (
    <form
      className="flex items-center gap-[var(--bp-space-2)] border-t border-[color:var(--bp-border)] pt-[var(--bp-space-2)]"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) void onAdd(size)
      }}
    >
      <SizeField label="Width" value={width} onChange={setWidth} testId="add-pane-width" />
      <span className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">×</span>
      <SizeField label="Height" value={height} onChange={setHeight} testId="add-pane-height" />
      <Button
        type="submit"
        size="xs"
        variant="outline"
        disabled={!valid}
        data-testid="add-pane-custom"
        className="ml-auto"
      >
        Add
      </Button>
    </form>
  )
}

function SizeField({
  label,
  value,
  onChange,
  testId
}: {
  label: string
  value: string
  onChange(value: string): void
  testId: string
}): React.JSX.Element {
  return (
    <Input
      aria-label={label}
      placeholder={label}
      inputMode="numeric"
      value={value}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
      className="h-[var(--bp-row-md)] w-16 rounded-[var(--bp-radius-sm)] bg-[var(--bp-chrome-sunken)] px-[var(--bp-space-2)] font-mono text-[length:var(--bp-text-sm)] md:text-[length:var(--bp-text-sm)]"
    />
  )
}
