import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { cn } from "cn"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { SearchIcon } from "lucide-react"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        // No padding: the search row, the rows and the footer are flush bands that run
        // the full width of the surface, divided by rules rather than by gaps.
        "flex size-full flex-col overflow-hidden rounded-[var(--bp-radius-lg)]! bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden rounded-[var(--bp-radius-lg)]! p-0",
          className
        )}
        showCloseButton={showCloseButton}
      >
        {/* The root every part below needs. Edited in place rather than wrapped at each
            use site, per AGENTS.md. */}
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The search row, which is a header rather than a field: a flush band the width of the
 * surface, ruled off from the list below it. There is nothing else on this surface to
 * take focus, so a well drawn around the input would only be a box inside a box — the
 * row is the field, and `index.css` keeps the focus ring off the control.
 *
 * `hint` is the shortcut that opened it, sat at the trailing edge in mono, where the
 * prototype puts it.
 */
function CommandInput({
  className,
  hint,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & { hint?: React.ReactNode }) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-[var(--bp-switcher-search-h)] flex-none items-center gap-[var(--bp-space-3)] border-b border-[color:var(--bp-border)] px-[var(--bp-space-4)]"
    >
      <SearchIcon className="size-4 shrink-0 text-[color:var(--bp-ink-faint)]" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[length:var(--bp-text-xl)] text-[color:var(--bp-ink)] outline-hidden placeholder:text-[color:var(--bp-ink-faint)] disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {hint !== undefined && (
        <span className="flex-none font-[family-name:var(--bp-font-mono)] text-[length:var(--bp-text-micro)] text-[color:var(--bp-ink-faint)]">
          {hint}
        </span>
      )}
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-[var(--bp-switcher-list-h)] scroll-py-[var(--bp-space-2)] overflow-x-hidden overflow-y-auto py-[var(--bp-space-2)] outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        "py-[var(--bp-space-6)] text-center text-[length:var(--bp-text-lg)] text-[color:var(--bp-ink-faint)]",
        className
      )}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

/**
 * One row. Flush and square rather than an inset pill: a row is the full width of the
 * surface, and its selection is read by running edge to edge, the way the prototype
 * draws it. Selection is `--bp-selected`, the accent wash, so the row that Enter opens
 * is distinguishable from the row merely under the pointer.
 */
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex h-[var(--bp-switcher-row-h)] cursor-default items-center gap-[var(--bp-space-3)] px-[var(--bp-space-4)] text-[length:var(--bp-text-lg)] text-[color:var(--bp-ink)] outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-[color:var(--bp-selected)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
    </CommandPrimitive.Item>
  )
}

/**
 * The strip along the bottom that says what the keys do. Sunken, so it reads as chrome
 * belonging to the surface rather than as another row that could be chosen.
 */
function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex h-[var(--bp-row-md)] flex-none items-center gap-[var(--bp-space-5)] border-t border-[color:var(--bp-border)] bg-[color:var(--bp-chrome-sunken)] px-[var(--bp-space-4)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
