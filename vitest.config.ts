import { defineConfig } from 'vitest/config'

// Shared logic and isolated lifecycle failures run here. Tests that need a real app
// run in the Playwright harness under e2e/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
