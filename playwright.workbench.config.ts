import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "./tests/org-policy/workbench/browser/setup.ts",
  testDir: "./tests/org-policy/workbench/browser",
  testMatch: "**/*.spec.ts",
  outputDir: ".aih-scratch/workbench-browser-results",
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    // Keep step/error traces without repeatedly copying large catalog DOMs or
    // duplicating V8 coverage attachments, which remain in the test results.
    trace: {
      mode: "retain-on-failure",
      attachments: false,
      screenshots: false,
      snapshots: false,
      sources: false,
    },
    screenshot: "only-on-failure",
  },
});
