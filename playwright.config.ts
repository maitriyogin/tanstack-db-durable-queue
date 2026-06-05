import { defineConfig, devices } from '@playwright/test';

const FE_PORT = 3000;
const BFF_PORT = 4010;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://localhost:${FE_PORT}`,
    trace: 'retain-on-failure',
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      // Use the system-installed Chrome instead of downloading Playwright's
      // chromium build. Avoids the ~170MB download and any Gatekeeper/EDR
      // stalls during the post-download extract.
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command: 'bun run dev:bff',
      cwd: '.',
      url: `http://localhost:${BFF_PORT}/graphql`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Use the production-mode start script for the FE so HMR is OFF.
      // The HMR WebSocket disconnects when Playwright sets context offline,
      // which causes Bun to re-evaluate modules and re-suspend the dbReady
      // gate — exposing an OPFS / Suspense interaction that has nothing to
      // do with what the offline tests are actually trying to verify.
      command: 'bun run --cwd fe-todos start',
      cwd: '.',
      url: `http://localhost:${FE_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { PORT: String(FE_PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
