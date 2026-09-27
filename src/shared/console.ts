import {
  LOG_SOURCES,
  type ConsoleEntryBody,
  type ConsoleLevel,
  type ConsoleSource,
  type SourceLocation,
  type StackFrame
} from './event-log'

/**
 * Console capture: what a pane's attachment hears, turned into event log entries.
 *
 * The attachment enables `Runtime` and `Log` and nothing else ([ADR-0019]). `Runtime`
 * carries the page's console calls and its uncaught exceptions and rejections; `Log`
 * carries the browser's own messages — CORS, CSP, mixed content, failed requests,
 * deprecations — each with a `source` saying what kind it is, which is why neither
 * `Network` nor `Page` is needed.
 *
 * Pure: the pane host hands this every debugger message and appends what comes back.
 * Anything that is not console output comes back `null`. Only what stays true is kept
 * ([ADR-0021]): previews, never the handles they were made from.
 */

/**
 * The commands that turn capture on, in order. `Runtime.enable` also replays what the
 * page logged before it was sent, which is the only way a message from before the page's
 * own scripts ran is captured — so it is sent on whichever attempt attaches.
 */
export const CONSOLE_ENABLE_COMMANDS = ['Runtime.enable', 'Log.enable'] as const

/** Frames kept of a stack: enough to find the call site, bounded whatever the page does. */
export const MAX_STACK_FRAMES = 32

/** The parts of CDP's `Runtime.RemoteObject` a preview reads. */
interface RemoteObject {
  type?: string
  subtype?: string
  className?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  preview?: ObjectPreview
}

interface ObjectPreview {
  type?: string
  subtype?: string
  description?: string
  overflow?: boolean
  properties?: PropertyPreview[]
  entries?: { key?: ObjectPreview; value?: ObjectPreview }[]
}

interface PropertyPreview {
  name?: string
  type?: string
  subtype?: string
  value?: string
}

interface CallFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

interface StackTrace {
  callFrames?: CallFrame[]
}

/**
 * One attachment's listener: `consoleEntryFor`, less whatever a world other than the
 * page's own logged into it. Electron runs its preload bootstrap in an isolated world in
 * every guest and warns from there about the app's security, which is about Breakpoint
 * and not about the page. Only a context CDP has said is not a default one is dropped;
 * one it has said nothing about is the page's.
 *
 * `Runtime.enable` announces the contexts that exist before it replays what they logged,
 * so the replay is judged by the same rule. Replayed arguments arrive without their
 * object previews — V8 does not keep them — and read as `Object`, `Array(2)`.
 */
export class ConsoleCapture {
  private readonly foreign = new Set<number>()

  hear(method: string, params: unknown): ConsoleEntryBody | null {
    if (!isRecord(params)) return null
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const context = isRecord(params.context) ? params.context : {}
        const aux = isRecord(context.auxData) ? context.auxData : {}
        if (typeof context.id === 'number' && aux.isDefault === false) {
          this.foreign.add(context.id)
        }
        return null
      }
      case 'Runtime.executionContextDestroyed':
        if (typeof params.executionContextId === 'number') {
          this.foreign.delete(params.executionContextId)
        }
        return null
      case 'Runtime.executionContextsCleared':
        this.foreign.clear()
        return null
      case 'Runtime.consoleAPICalled':
        if (this.isForeign(params.executionContextId)) return null
        break
      case 'Runtime.exceptionThrown':
        if (isRecord(params.exceptionDetails)) {
          if (this.isForeign(params.exceptionDetails.executionContextId)) return null
        }
        break
    }
    return consoleEntryFor(method, params)
  }

  private isForeign(context: unknown): boolean {
    return typeof context === 'number' && this.foreign.has(context)
  }
}

export function consoleEntryFor(method: string, params: unknown): ConsoleEntryBody | null {
  if (!isRecord(params)) return null
  switch (method) {
    case 'Runtime.consoleAPICalled':
      return consoleCall(params)
    case 'Runtime.exceptionThrown':
      return isRecord(params.exceptionDetails) ? exception(params.exceptionDetails) : null
    case 'Log.entryAdded':
      return isRecord(params.entry) ? browserMessage(params.entry) : null
    default:
      return null
  }
}

function consoleCall(params: Record<string, unknown>): ConsoleEntryBody | null {
  if (typeof params.type !== 'string' || !Array.isArray(params.args)) return null
  const args = params.args.filter(isRecord) as RemoteObject[]
  const stack = stackOf(params.stackTrace)
  return {
    type: 'console.message',
    level: consoleLevel(params.type),
    source: 'console',
    text: formatArgs(args),
    args: args.map(preview),
    url: null,
    location: innermost(stack),
    stack
  }
}

/**
 * V8 reports an unhandled rejection through the same event as an uncaught exception, and
 * says which it was only in the headline.
 */
function exception(details: Record<string, unknown>): ConsoleEntryBody {
  const headline = typeof details.text === 'string' ? details.text : 'Uncaught'
  const thrown = isRecord(details.exception) ? preview(details.exception as RemoteObject) : null
  const stack = stackOf(details.stackTrace)
  const alreadySaid = thrown !== null && (headline === thrown || headline.endsWith(` ${thrown}`))
  return {
    type: 'console.exception',
    rejection: headline.startsWith('Uncaught (in promise)'),
    text: thrown === null || alreadySaid ? headline : `${headline} ${thrown}`,
    error: thrown,
    location: innermost(stack) ?? reportedLocation(details),
    stack
  }
}

function browserMessage(entry: Record<string, unknown>): ConsoleEntryBody {
  const stack = stackOf(entry.stackTrace)
  return {
    type: 'console.message',
    level: logLevel(entry.level),
    source: logSource(entry.source),
    text: typeof entry.text === 'string' ? entry.text : '',
    args: Array.isArray(entry.args)
      ? (entry.args.filter(isRecord) as RemoteObject[]).map(preview)
      : [],
    url: typeof entry.url === 'string' && entry.url !== '' ? entry.url : null,
    location: innermost(stack) ?? reportedLocation(entry),
    stack
  }
}

// ---------------------------------------------------------------------------------------
// Levels and sources
// ---------------------------------------------------------------------------------------

/** By console method; everything that is not a level of its own prints as a log. */
function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'debug':
    case 'info':
    case 'error':
      return type
    case 'warning':
      return 'warn'
    case 'assert':
      return 'error'
    default:
      return 'log'
  }
}

function logLevel(level: unknown): ConsoleLevel {
  switch (level) {
    case 'verbose':
      return 'debug'
    case 'warning':
      return 'warn'
    case 'error':
      return 'error'
    default:
      return 'info'
  }
}

const KNOWN_LOG_SOURCES: ReadonlySet<string> = new Set(LOG_SOURCES)

/** A source a later Chromium adds is still a browser message, so it is kept as `other`. */
function logSource(source: unknown): ConsoleSource {
  return typeof source === 'string' && KNOWN_LOG_SOURCES.has(source)
    ? (source as ConsoleSource)
    : 'other'
}

// ---------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------

/** CDP counts lines and columns from zero; an editor, and every entry, from one. */
function stackOf(trace: unknown): StackFrame[] {
  if (!isRecord(trace) || !Array.isArray((trace as StackTrace).callFrames)) return []
  return ((trace as StackTrace).callFrames ?? [])
    .filter(isRecord)
    .slice(0, MAX_STACK_FRAMES)
    .map((frame: CallFrame) => ({
      function: typeof frame.functionName === 'string' ? frame.functionName : '',
      url: typeof frame.url === 'string' ? frame.url : '',
      line: oneBased(frame.lineNumber),
      column: oneBased(frame.columnNumber),
      resolution: 'failed',
      path: null
    }))
}

/**
 * Where the stack says it happened: its innermost frame, less the function name. Every
 * location starts unresolved; resolution happens before the append ([ADR-0020]).
 */
function innermost(stack: readonly StackFrame[]): SourceLocation | null {
  if (!stack[0]) return null
  const { url, line, column } = stack[0]
  return { url, line, column, resolution: 'failed', path: null }
}

/** Where a message with no stack says it came from, if it says. */
function reportedLocation(fields: Record<string, unknown>): SourceLocation | null {
  if (typeof fields.url !== 'string' || fields.url === '') return null
  if (typeof fields.lineNumber !== 'number') return null
  return {
    url: fields.url,
    line: oneBased(fields.lineNumber),
    column: oneBased(fields.columnNumber),
    resolution: 'failed',
    path: null
  }
}

function oneBased(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value + 1 : 1
}

// ---------------------------------------------------------------------------------------
// Text and previews
// ---------------------------------------------------------------------------------------

/**
 * What the console prints for a call: a leading string's format specifiers filled from
 * the arguments after it, and whatever is left over after that, space-separated.
 */
function formatArgs(args: readonly RemoteObject[]): string {
  const [first, ...rest] = args
  if (!first) return ''
  if (first.type !== 'string' || typeof first.value !== 'string') {
    return args.map(preview).join(' ')
  }
  const remaining = [...rest]
  const formatted = first.value.replace(/%([sdifoOc%])/g, (specifier, letter: string) => {
    if (letter === '%') return '%'
    const arg = remaining[0]
    if (!arg) return specifier
    remaining.shift()
    switch (letter) {
      case 'c':
        return ''
      case 'd':
      case 'i':
        return typeof arg.value === 'number' ? String(Math.trunc(arg.value)) : 'NaN'
      case 'f':
        return typeof arg.value === 'number' ? String(arg.value) : 'NaN'
      default:
        return preview(arg)
    }
  })
  return [formatted, ...remaining.map(preview)].join(' ')
}

/** One argument as the console prints it: a string bare, anything else as it reads. */
function preview(object: RemoteObject): string {
  switch (object.type) {
    case 'string':
      return typeof object.value === 'string' ? object.value : ''
    case 'undefined':
      return 'undefined'
    case 'number':
    case 'bigint':
    case 'boolean':
      return object.unserializableValue ?? object.description ?? String(object.value)
    case 'object':
      if (object.subtype === 'null') return 'null'
      if (object.subtype === 'error') return withoutStack(object.description ?? 'Error')
      if (object.preview) return objectPreview(object.preview)
      return object.description ?? object.className ?? 'Object'
    default:
      return object.description ?? String(object.type)
  }
}

/** An error's description is its `stack`; the frames are kept as frames, not as text. */
function withoutStack(description: string): string {
  const at = description.search(/\n\s+at\s/)
  return at === -1 ? description : description.slice(0, at)
}

function objectPreview(preview: ObjectPreview): string {
  const description = preview.description ?? 'Object'
  const more = preview.overflow ? ['…'] : []
  switch (preview.subtype) {
    case 'array':
    case 'typedarray': {
      const items = (preview.properties ?? []).map(propertyValue)
      return `${description} [${[...items, ...more].join(', ')}]`
    }
    case 'map':
    case 'weakmap':
    case 'set':
    case 'weakset': {
      const items = (preview.entries ?? []).map(({ key, value }) =>
        key ? `${entryValue(key)} => ${entryValue(value)}` : entryValue(value)
      )
      return `${description} {${[...items, ...more].join(', ')}}`
    }
    case undefined: {
      const items = (preview.properties ?? []).map(
        (property) => `${property.name ?? ''}: ${propertyValue(property)}`
      )
      const body = `{${[...items, ...more].join(', ')}}`
      return description === 'Object' ? body : `${description} ${body}`
    }
    default:
      return description
  }
}

function propertyValue(property: PropertyPreview): string {
  if (property.type === 'string') return `'${property.value ?? ''}'`
  if (property.type === 'object' && property.subtype === 'null') return 'null'
  return property.value ?? '…'
}

function entryValue(preview: ObjectPreview | undefined): string {
  if (!preview) return 'undefined'
  if (preview.type === 'string') return `'${preview.description ?? ''}'`
  return preview.description ?? String(preview.type)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
