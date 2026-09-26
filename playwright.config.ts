import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.COMIC_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), "comic-shelf-e2e-"));
process.env.COMIC_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "npm start -- --port 3210",
    url: "http://127.0.0.1:3210/api/session",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATA_DIR: dataDir,
      BOOKS_PASSWORD: "test-only-comic-shelf-passphrase",
      MAX_UPLOAD_MB: "16",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
