# Breakpoint — the Site

The public web presence for Breakpoint: the landing page at `/` and the Docs at `/docs`,
built as one Astro project and deployed as one Netlify site.

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # -> dist/
npm run preview
```

This project has its own `package-lock.json` and is **not** part of an npm workspace. The
repository root is an Electron app whose `postinstall` runs `electron-builder
install-app-deps`; keeping the trees separate stops Astro's dependencies from ending up
in the tree that rebuilds native modules. You install twice, on purpose. See
`docs/adr/0014-astro-starlight-for-the-site.md`.

## Layout

| Path | What it is |
| --- | --- |
| `src/pages/index.astro` | The landing page, ported from the design prototype |
| `src/layouts/MarketingLayout.astro` | Nav, footer and page chrome for non-Docs pages |
| `src/content/docs/docs/` | The Docs. The doubled path is what serves them at `/docs/**` |
| `src/styles/nocturne.css` | The design-system tokens this site uses, extracted from the prototype |
| `src/styles/site-tokens.css` | The site's own tokens, copied verbatim from the prototype |
| `src/styles/starlight.css` | Maps Starlight's `--sl-*` onto the tokens above |
| `scripts/capture-demo.sh` | Regenerates the demo still from the design prototype |

## Design

`docs/design/site/` in the repository root is the source of truth for the landing page.
`Breakpoint Site.dc.html` is the page; `site-tokens.css` is its token layer and is
mirrored here byte-for-byte.

Two standing rules carried over from the app:

- **Never invent a token.** If a value is missing, add it to `src/styles/nocturne.css`
  from the prototype's design-system bundle first, then use it.
- **The prototype wins.** If this site and the prototype disagree, change the prototype
  first.

## Deployment

Netlify, from the single `netlify.toml` at the repository root, which sets
`base = "sites/web"`. There must not be a second `netlify.toml` in this directory — it
would silently take precedence.

The site is deployed unlisted until there is a packaged build of the app to download. The
landing page describes features across several build phases, which is safe while it is
not public and is not once it is.
