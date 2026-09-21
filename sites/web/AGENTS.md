## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## This project

The Breakpoint Site: landing page at `/`, Docs at `/docs`. See `README.md` for layout and
the design rules, and `docs/adr/0014-astro-starlight-for-the-site.md` in the repository
root for why it is built this way.

Three things that will bite if you do not know them:

- **Docs content lives in `src/content/docs/docs/`.** The doubled path is Starlight's
  subpath convention and is what serves the Docs at `/docs/**` while `/` stays with
  `src/pages/index.astro`. Do not "fix" it.
- **`vite.tsconfig` and `vite.resolve.tsconfigPaths` in `astro.config.mjs` are load
  bearing.** Without them the build walks up into the Electron app's tsconfig and fails
  on a dependency this project does not have. The comments there explain it.
- **Vocabulary.** "Docs" means the public documentation on this site. The repository's
  `docs/` directory is "internal docs" and is never published. See `CONTEXT.md` at the
  repository root.
