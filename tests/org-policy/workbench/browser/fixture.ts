import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "@playwright/test";
import { preparePackedWorkbench } from "../../../../tools/prepare-packed-workbench.mjs";

type BrowserFixtures = {
  artifact: string;
  preparedArtifact: string;
  workbench: { path: string; networkRequests: string[] };
};

const packedArtifacts = new Map<string, Promise<void>>();

export const test = base.extend<BrowserFixtures>({
  artifact: ["aih-policy-workbench.html", { option: true }],
  // Automatic fixtures finish before page/context setup. Only the packed journey
  // pays for the cold package consumer; global teardown still owns its cleanup.
  preparedArtifact: [
    async ({ artifact }, use) => {
      const directory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
      if (!directory) throw new Error("Workbench fixtures were not prepared");
      if (artifact === "packed-policy-workbench.html") {
        let preparation = packedArtifacts.get(directory);
        if (!preparation) {
          preparation = Promise.resolve().then(async () => {
            // Playwright replaces a worker after a failed test. Reuse the completed
            // immutable package fixture rather than creating its directories again.
            try {
              JSON.parse(await readFile(resolve(directory, "package-receipt.json"), "utf8"));
              await readFile(resolve(directory, artifact));
              return;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const packed = preparePackedWorkbench(directory);
            await writeFile(
              resolve(directory, "package-receipt.json"),
              JSON.stringify(packed, null, 2),
            );
          });
          packedArtifacts.set(directory, preparation);
        }
        await preparation;
      }
      await use(resolve(directory, artifact));
    },
    { auto: true },
  ],
  workbench: async ({ page, context, preparedArtifact }, use, testInfo) => {
    const path = testInfo.outputPath("aih-policy-workbench.html");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(preparedArtifact, path);
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
