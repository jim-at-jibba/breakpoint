import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.proof\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  outputDir: '../raw/pw-out',
  reporter: 'list'
})
