# Astro and Starlight for the Site, as one app under `sites/web`

The Site needs a bespoke landing page and conventional documentation behind the same
design language. We chose Astro with the Starlight documentation theme, as a single
project at `sites/web`, rather than Docusaurus: Starlight is themed through CSS custom
properties and component overrides, and underneath it is ordinary Astro, so the landing
page is a normal `.astro` page in the same project instead of a second framework.

## Considered Options

**Docusaurus** is the obvious default and was the starting assumption. It wins on
versioned documentation with a version dropdown, i18n, and its plugin ecosystem. It
loses on theming: Infima plus swizzling is a poor fit for the bespoke design the design
prototype settles, and it would have meant running a second framework for the landing
page. Versioned docs are the real thing given up — Breakpoint is pre-v1 and has nothing
to version yet.

**Two projects** — Astro for marketing, a docs framework for Docs — was rejected because
the nav, footer and tokens are shared furniture, so it buys a duplicated design layer and
a cross-origin navigation for no gain.

## Consequences

- Docs content lives at `src/content/docs/docs/**` to serve at `/docs/**`. The doubled
  path is Starlight's supported subpath convention, not an accident.
- Search is Pagefind, built statically at deploy time. No Algolia application, no service
  to keep alive.
- `sites/web` is a standalone npm project with its own lockfile. The root stays a plain
  Electron app with no workspaces, so `electron-builder install-app-deps` never sees
  Astro's dependency tree.
- Exactly one `netlify.toml`, at the repository root, setting `base = "sites/web"`. A
  second one inside `sites/web` would silently take over.
