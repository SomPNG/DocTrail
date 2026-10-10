import { defineConfig } from 'vitest/config';

// Tests run against their own SQLite file (prisma/test.db), recreated and seeded once per run,
// so they never touch or depend on your dev.db.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: ['./tests/setup/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./test.db',
      DEMO_MODE: 'true',
      SIMULATION_ENABLED: 'true',
      SLA_WATCHDOG_ENABLED: 'false',
    },
  },
});
