import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Persistence tests fsync real files; CI disks (macOS runners) can take seconds.
    testTimeout: 15_000,
  },
})
