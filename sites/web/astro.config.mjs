// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  // TODO: swap for the custom domain when one is pointed at this project.
  // Until then this only affects canonical URLs and the sitemap.
  site: 'https://breakpoint.netlify.app',

  vite: {
    // Pin the tsconfig for the transform step, so the oxc transformer uses this
    // project's config instead of searching upward and finding the Electron
    // app's. Same root cause as the resolve setting below.
    tsconfig: './tsconfig.json',

    resolve: {
      // Astro turns Vite's tsconfig-paths resolution on; Vite's own default is
      // off. Leave it off here.
      //
      // With it on, the resolver walks up out of sites/web, finds the repo
      // root's solution-style tsconfig.json, and parses everything it
      // references — including tsconfig.node.json, which extends
      // @electron-toolkit/tsconfig. That package belongs to the Electron app,
      // not to this site, so it is absent whenever the root has no
      // node_modules: on a fresh clone, and on every Netlify build, since
      // Netlify installs in the base directory only. The build then dies with
      // "Tsconfig not found @electron-toolkit/tsconfig/tsconfig.node.json".
      //
      // This site's tsconfig.json declares no `paths`, so the feature buys us
      // nothing. Turning it off is the whole fix, and it costs the app nothing.
      // Revisit if this project ever wants import aliases.
      tsconfigPaths: false,
    },
  },

  integrations: [
    starlight({
      title: 'Breakpoint',
      description:
        'Documentation for Breakpoint, a multi-viewport dev browser for developers and their coding agents.',

      // Docs content lives in src/content/docs/docs/ so that it serves at
      // /docs/**, leaving / to src/pages/index.astro. This is Starlight's
      // supported subpath convention, not a workaround. See docs/adr/0001.

      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/jim-at-jibba/breakpoint' },
      ],

      customCss: [
        './src/styles/nocturne.css',
        './src/styles/site-tokens.css',
        './src/styles/starlight.css',
      ],

      components: {
        // The Site is dark-only: pin the theme and remove the picker.
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },

      sidebar: [
        { label: 'Start here', items: [{ slug: 'docs' }, { slug: 'docs/install' }, { slug: 'docs/quickstart' }] },
        { label: 'Reference', items: [{ slug: 'docs/cli' }] },
      ],
    }),
  ],
});
