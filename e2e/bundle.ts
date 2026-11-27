import { join } from 'node:path'

/**
 * The fixture's production-style bundle: `e2e/bundled/src/`, built by Vite when the tests
 * run — minified onto one line, hashed, with a source map beside it — and never written
 * to disk or committed. A map hand-authored to satisfy the resolver would prove nothing
 * about the resolver, and one shaped only like a dev server's answer would ship the fetch
 * untested ([ADR-0020]).
 *
 * Built as though its root were a repo: a test whose repo holds `BUNDLED_SOURCES` at
 * `src/` expects an error thrown from the bundle to resolve there.
 *
 * Two entries, sharing nothing, so that what one throws never reaches a test of the other:
 * `main` throws at every width, and `responsive` only in a pane narrower than its nav.
 */

/** The page that loads the bundle, and the directory everything it built is served from. */
export const BUNDLE_PATH = '/bundled'

/** The sources the bundle is built from, which a test copies into its repo as `src/`. */
export const BUNDLED_SOURCES = join(__dirname, 'bundled', 'src')

/** The bundle's entries, each a module in `BUNDLED_SOURCES` of the same name. */
export const BUNDLE_ENTRIES = ['main', 'responsive'] as const
export type BundleEntry = (typeof BUNDLE_ENTRIES)[number]

/** `/bundled` loads `main`; `/bundled?entry=responsive` loads the other. */
export function bundledPageFor(entry: BundleEntry): string {
  return entry === 'main' ? BUNDLE_PATH : `${BUNDLE_PATH}?entry=${entry}`
}

export interface Bundle {
  /** Each entry's origin-relative script path, such as `/bundled/main-3f9a1c.js`. */
  entries: Readonly<Record<BundleEntry, string>>
  /** Everything the build emitted, the entry and its map included, by path. */
  files: ReadonlyMap<string, string>
}

let built: Promise<Bundle> | undefined

/** The bundle, built once per test process. */
export function bundle(): Promise<Bundle> {
  built ??= build()
  return built
}

async function build(): Promise<Bundle> {
  const vite = await import('vite')
  const root = join(BUNDLED_SOURCES, '..')
  const result = await vite.build({
    configFile: false,
    envFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      sourcemap: true,
      modulePreload: false,
      rollupOptions: {
        input: Object.fromEntries(
          BUNDLE_ENTRIES.map((name) => [name, join(BUNDLED_SOURCES, `${name}.js`)])
        ),
        output: { entryFileNames: `${BUNDLE_PATH.slice(1)}/[name]-[hash].js` }
      }
    }
  })
  const outputs = Array.isArray(result) ? result : [result]
  const files = new Map<string, string>()
  const entries: Partial<Record<BundleEntry, string>> = {}
  for (const output of outputs) {
    if (!('output' in output)) throw new Error('The fixture bundle was built to watch')
    for (const emitted of output.output) {
      if (emitted.type === 'chunk') {
        files.set(`/${emitted.fileName}`, emitted.code)
        if (emitted.isEntry) entries[emitted.name as BundleEntry] = `/${emitted.fileName}`
      } else {
        files.set(`/${emitted.fileName}`, String(emitted.source))
      }
    }
  }
  for (const name of BUNDLE_ENTRIES) {
    if (!entries[name]) throw new Error(`The fixture bundle has no ${name} entry`)
  }
  return { entries: entries as Record<BundleEntry, string>, files }
}
