import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "@playwright/test";

type BrowserFixtures = {
  artifact: string;
  workbench: { path: string; networkRequests: string[] };
};

export const test = base.extend<BrowserFixtures>({
  artifact: ["aih-policy-workbench.html", { option: true }],
  workbench: async ({ page, context, artifact }, use, testInfo) => {
    const directory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
    if (!directory) throw new Error("Workbench fixtures were not prepared");
    const path = testInfo.outputPath("aih-policy-workbench.html");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(resolve(directory, artifact), path);
    const networkRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    page.on("request", (request) => {
      if (/^https?:/u.test(request.url())) networkRequests.push(request.url());
    });
    await context.route(/^https?:/u, (route) => route.abort());
    await page.coverage.startJSCoverage({ reportAnonymousScripts: true });
    await page.goto(pathToFileURL(path).href);
    expect(pageErrors, "portable Workbench startup failed").toEqual([]);
    await expect(page.locator("#config-preview")).toBeAttached();
    await use({ path, networkRequests });
    const coverage = (await page.coverage.stopJSCoverage()).filter((entry) =>
      entry.source?.startsWith("/* aih-workbench-ui/v1 */"),
    );
    expect(coverage.length, "browser UI must produce V8 coverage").toBeGreaterThan(0);
    const coveragePath = testInfo.outputPath("workbench-ui-v8-coverage.json");
    await writeFile(coveragePath, JSON.stringify(coverage));
    await testInfo.attach("workbench-ui-v8-coverage", {
      path: coveragePath,
      contentType: "application/json",
    });
    expect(pageErrors, "portable Workbench script failed").toEqual([]);
    expect(networkRequests, "portable Workbench attempted a network request").toEqual([]);
  },
});

export { expect };
