import { defineConfig } from '@playwright/test'

// The integration seam: a harness that launches the real app in its packaged shape —
// the built `out/` bundle, not the sources — and drives it with the CLI as a subprocess,
// asserting on payloads and exit codes.
//
// Serial by design. Each test owns a user data directory and therefore a socket, but the
// single-instance lock is per user data directory and Electron launches are heavy enough
// that overlapping them buys nothing.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Scaled by the same factor as the harness's own deadlines (e2e/harness.ts PATIENCE).
  // Without this the per-test timeout fires first and the scaling buys nothing.
  timeout: process.env.CI ? 180_000 : 60_000,
  reporter: process.env.CI ? 'github' : 'list'
})
