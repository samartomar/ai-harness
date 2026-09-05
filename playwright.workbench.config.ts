import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "./tests/org-policy/workbench/browser/setup.ts",
  testDir: "./tests/org-policy/workbench/browser",
  testMatch: "**/*.spec.ts",
  outputDir: ".aih-scratch/workbench-browser-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
