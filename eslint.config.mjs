import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // prototypes/ is throwaway spike code kept as a primary source, and docs/ holds
  // generated design artefacts. Neither is ours to lint. .astro/ is Astro's generated
  // types for the site, which appear the first time the site is built and would
  // otherwise fail this lint with errors in code nobody wrote.
  {
    ignores: ['**/node_modules', '**/dist', '**/out', '**/.astro', 'prototypes/**', 'docs/**']
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier,
  // shadcn/ui output is owned by the CLI (see AGENTS.md). Re-running `add --overwrite`
  // discards anything a linter fixed here, so the generator's formatting and export
  // shape are left alone rather than churned on every regeneration.
  {
    files: ['src/renderer/src/components/ui/**', 'src/renderer/src/lib/utils.ts'],
    rules: {
      'prettier/prettier': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'react-refresh/only-export-components': 'off'
    }
  }
)
