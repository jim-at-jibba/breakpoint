import { defineConfig } from 'vitest/config'

// The unit seam: pure functions in the shared module both processes import. Anything
// that needs a real app runs in the Playwright harness under e2e/ instead — the repo
// has two test runners on purpose and does not want a third.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
