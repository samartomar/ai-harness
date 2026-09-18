import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * NEW-SHELL-PLAN.md S6: developer tool setup moved to the new shell's
 * organization screen. The generated pages open with `?shell=new` (the local
 * shell switch) and the journeys navigate to the screen that holds each
 * control; every assertion is unchanged.
 */
const NEW_SHELL = "?shell=new";

async function openScreen(page: import("@playwright/test").Page, name: string) {
  await page
    .getByRole("navigation", { name: "Workbench screens" })
    .getByRole("button", { name, exact: true })
    .click();
}

const tools = [
  ["code-review-graph", "Code Review Graph"],
  ["codebase-memory-mcp", "Codebase Memory MCP"],
  ["serena", "Serena"],
  ["token-optimizer", "Token Optimizer"],
  ["context7", "Context7"],
  ["markitdown", "MarkItDown CLI"],
  ["playwright", "Playwright"],
] as const;

const setupOwnedCatalogAssets = [
  ["source:aih-core", "aih/code-review-graph"],
  ["source:aih-core", "aih/codebase-memory-mcp"],
  ["source:aih-core", "aih/context7"],
  ["source:aih-core", "aih/playwright"],
  ["source:aih-core", "aih/serena"],
  ["source:ecc", "ecc/mcp:code-review-graph"],
  ["source:ecc", "ecc/mcp:codebase-memory-mcp"],
  ["source:ecc", "ecc/mcp:context7"],
  ["source:ecc", "ecc/mcp:token-optimizer"],
] as const;

for (const [excludedId, excludedLabel] of [
  ["context7", "Context7"],
  ["markitdown", "MarkItDown CLI"],
  ["playwright", "Playwright"],
] as const) {
  test(`persists ${excludedLabel} opt-out and explicit-empty choices through browser export, import, and public CLI reopen`, async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(testInfo.outputPath("developer-tool-policy-"));
    const cli = resolve("dist/cli.js");
    const commands: Array<{ argv: string[]; status: number | null; stderr: string }> = [];
    const invoke = (argv: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...argv], {
        cwd: directory,
        env: {
          ...process.env,
          AIH_WORKBENCH_DATA: resolve(directory, "source-data"),
          AIH_WORKBENCH_VERIFIER_HOME: resolve(directory, "verifier"),
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 40_000,
      });
      commands.push({ argv, status: result.status, stderr: result.stderr });
      expect(result.status, result.stderr || result.stdout).toBe(0);
    };

    const errors: string[] = [];
    const networkRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/u.test(request.url())) networkRequests.push(request.url());
    });
    await context.route(/^https?:/u, (route) => route.abort());

    invoke(["policy", "generate", "--out", "author.html", "--apply", "--json"]);
    await page.goto(pathToFileURL(resolve(directory, "author.html")).href + NEW_SHELL);
    const disclosure = page.locator("#developer-tool-selection");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(disclosure.locator("summary")).toContainText(/all default tools selected/i);
    await openScreen(page, "Organization");
    await disclosure.locator("summary").click();

    const rows = page.locator("[data-developer-tool-id]");
    await expect(rows).toHaveCount(tools.length);
    for (const [id, label] of tools) {
      const row = page.locator(`[data-developer-tool-id="${id}"]`);
      await expect(row).toContainText(label);
      await expect(row).toContainText("Selected: pending setup");
    }
    expect(JSON.parse(await page.locator("#config-preview").inputValue())).not.toHaveProperty(
      "developerTools",
    );
    // This journey isolates developer setup from Core control deployment prerequisites.
    await page.locator("#policy-file").setInputFiles({
      name: "developer-tools-only.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          minimumPosture: "vibe",
          references: { repoContract: "ai-coding/project.json" },
        }),
      ),
    });
    await expect
      .poll(
        async () => JSON.parse(await page.locator("#config-preview").inputValue()).schemaVersion,
      )
      .toBe(2);

    await expect(page.locator('[data-developer-tool-id="context7"]')).toContainText(
      "network requests subject to egress policy",
    );
    const excludedRow = page.locator(`[data-developer-tool-id="${excludedId}"]`);
    const excludeSelectedTool = excludedRow.getByRole("button", {
      name: `Exclude ${excludedLabel} from setup`,
    });
    await excludeSelectedTool.focus();
    await page.keyboard.press("Enter");
    await expect(excludedRow).toContainText("Excluded by policy");
    const excludedPolicy = JSON.parse(await page.locator("#config-preview").inputValue());
    expect(excludedPolicy).toMatchObject({
      schemaVersion: 3,
      developerTools: {
        selected: tools.map(([id]) => id).filter((id) => id !== excludedId),
        excluded: [excludedId],
      },
    });

    const excludedDownloadEvent = page.waitForEvent("download");
    await page.locator("#download").click();
    const excludedDownload = await excludedDownloadEvent;
    const excludedExported = resolve(directory, `${excludedId}-excluded.json`);
    await excludedDownload.saveAs(excludedExported);
    expect(JSON.parse(await readFile(excludedExported, "utf8"))).toEqual(excludedPolicy);

    invoke([
      "policy",
      "generate",
      "--policy-input",
      excludedExported,
      "--out",
      "excluded-reopened.html",
      "--apply",
      "--json",
    ]);
    await page.goto(pathToFileURL(resolve(directory, "excluded-reopened.html")).href + NEW_SHELL);
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(disclosure.locator("summary")).toContainText("1 excluded");
    await expect(excludedRow).toContainText("Excluded by policy");
    expect(JSON.parse(await page.locator("#config-preview").inputValue()).developerTools).toEqual(
      excludedPolicy.developerTools,
    );

    invoke(["policy", "generate", "--out", "excluded-import-target.html", "--apply", "--json"]);
    await page.goto(
      pathToFileURL(resolve(directory, "excluded-import-target.html")).href + NEW_SHELL,
    );
    await page.locator("#policy-file").setInputFiles(excludedExported);
    await expect
      .poll(
        async () => JSON.parse(await page.locator("#config-preview").inputValue()).developerTools,
      )
      .toEqual(excludedPolicy.developerTools);
    await expect(excludedRow).toContainText("Excluded by policy");

    await expect(disclosure.locator("summary")).toContainText("1 excluded");
    await openScreen(page, "Organization");
    await disclosure.locator("summary").click();
    await excludedRow.getByRole("button", { name: `Include ${excludedLabel} in setup` }).click();
    for (const [id, label] of tools) {
      await page
        .locator(`[data-developer-tool-id="${id}"]`)
        .getByRole("button", { name: `Remove ${label} from selection` })
        .click();
    }
    await expect(rows.first()).toContainText("Not selected");
    const emptyPolicy = JSON.parse(await page.locator("#config-preview").inputValue());
    expect(emptyPolicy.developerTools).toEqual({ selected: [] });

    const downloadEvent = page.waitForEvent("download");
    await page.locator("#download").click();
    const download = await downloadEvent;
    const emptyExported = resolve(directory, "developer-tools-empty.json");
    await download.saveAs(emptyExported);
    expect(JSON.parse(await readFile(emptyExported, "utf8"))).toEqual(emptyPolicy);

    invoke([
      "policy",
      "generate",
      "--policy-input",
      emptyExported,
      "--out",
      "reopened.html",
      "--apply",
      "--json",
    ]);
    await page.goto(pathToFileURL(resolve(directory, "reopened.html")).href + NEW_SHELL);
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(disclosure.locator("summary")).toContainText("0 selected");
    await expect(rows).toHaveCount(tools.length);
    for (const [id] of tools)
      await expect(page.locator(`[data-developer-tool-id="${id}"]`)).toContainText("Not selected");

    invoke(["policy", "generate", "--out", "import-target.html", "--apply", "--json"]);
    await page.goto(pathToFileURL(resolve(directory, "import-target.html")).href + NEW_SHELL);
    await page.locator("#policy-file").setInputFiles(emptyExported);
    await expect
      .poll(
        async () => JSON.parse(await page.locator("#config-preview").inputValue()).developerTools,
      )
      .toEqual({ selected: [] });
    await expect(disclosure.locator("summary")).toContainText("0 selected");

    await writeFile(
      testInfo.outputPath("developer-tool-browser-receipt.json"),
      JSON.stringify({ commands, errors, networkRequests }, null, 2),
    );
    expect(errors).toEqual([]);
    expect(networkRequests).toEqual([]);
  });
}

test("keeps setup-owned catalog duplicates out of browse while preserving saved Playwright requests", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(testInfo.outputPath("developer-tool-catalog-"));
  const cli = resolve("dist/cli.js");
  const generated = spawnSync(
    process.execPath,
    [cli, "policy", "generate", "--out", "author.html", "--apply", "--json"],
    {
      cwd: directory,
      env: {
        ...process.env,
        AIH_WORKBENCH_DATA: resolve(directory, "source-data"),
        AIH_WORKBENCH_VERIFIER_HOME: resolve(directory, "verifier"),
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 40_000,
    },
  );
  expect(generated.status, generated.stderr || generated.stdout).toBe(0);

  const errors: string[] = [];
  const networkRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) networkRequests.push(request.url());
  });
  await context.route(/^https?:/u, (route) => route.abort());
  await page.goto(pathToFileURL(resolve(directory, "author.html")).href + NEW_SHELL);

  const preview = page.locator("#config-preview");
  const disclosure = page.locator("#developer-tool-selection");
  await openScreen(page, "Organization");
  await disclosure.locator("summary").click();
  const playwrightTool = page.locator('[data-developer-tool-id="playwright"]');
  await expect(page.locator("[data-developer-tool-id]")).toHaveCount(7);
  await expect(playwrightTool).toHaveAttribute("data-developer-tool-state", "selected-pending");
  const beforeDetails = await preview.inputValue();
  await playwrightTool.locator('[data-developer-tool-details-id="playwright"]').click();
  const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
  await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", "aih/playwright");
  await expect(inspector.locator("[data-workbench-declaration]")).toBeVisible();
  await expect(inspector.locator("[data-workbench-checks]")).toBeVisible();
  await expect(preview).toHaveValue(beforeDetails);

  await playwrightTool
    .getByRole("button", { name: "Exclude Playwright from setup", exact: true })
    .click();
  await expect(playwrightTool).toHaveAttribute("data-developer-tool-state", "excluded");
  const excludedPolicy = JSON.parse(await preview.inputValue());
  expect(excludedPolicy.developerTools).toMatchObject({ excluded: ["playwright"] });
  if (excludedPolicy.authoringSelections === undefined)
    throw new Error("Expected a baseline Workbench selection state");
  const playwrightPin = await page.evaluate(() => {
    const model = (
      window as unknown as {
        __aihWorkbenchModel: {
          workbenchBundle: {
            assets: Record<
              string,
              {
                id: string;
                sourceId: string;
                sourceRevisionId: string;
                contentDigest: string;
              }
            >;
          };
        };
      }
    ).__aihWorkbenchModel;
    const asset = model.workbenchBundle.assets["aih/playwright"];
    if (asset === undefined) throw new Error("Expected the retained Playwright catalog asset");
    return {
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
      origin: { kind: "administrator" },
    };
  });
  const legacyPolicy = {
    ...excludedPolicy,
    authoringSelections: {
      ...excludedPolicy.authoringSelections,
      requests: [playwrightPin],
    },
  };
  await page.locator("#policy-file").setInputFiles({
    name: "saved-playwright-request.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacyPolicy)),
  });
  await expect
    .poll(async () => JSON.parse(await preview.inputValue()).authoringSelections.requests)
    .toEqual([playwrightPin]);
  await expect(playwrightTool).toHaveAttribute("data-developer-tool-state", "excluded");

  await openScreen(page, "Sources & Catalogs");
  const search = page.getByRole("searchbox", { name: "Search catalog" });
  for (const [sourceId, assetId] of setupOwnedCatalogAssets) {
    await search.fill("");
    await page.locator(`[data-workbench-source-tab="${sourceId}"]`).click();
    const row = page.locator(`article[data-workbench-asset-id="${assetId}"]`);
    await expect(row).toHaveCount(0);
    await search.fill(assetId);
    await expect(row).toHaveCount(0);
  }
  await page.locator('[data-workbench-source-tab="source:aih-core"]').click();
  await search.fill("aih/github");
  await expect(page.locator('article[data-workbench-asset-id="aih/github"]')).toHaveCount(0);
  for (const [sourceId, assetId] of [["source:ecc", "ecc/mcp:github"]] as const) {
    await page.locator(`[data-workbench-source-tab="${sourceId}"]`).click();
    await search.fill(assetId);
    await expect(page.locator(`article[data-workbench-asset-id="${assetId}"]`)).toBeVisible();
  }

  await page.locator(".workbench-draft-review > button[data-workbench-draft-open]").click();
  await expect(inspector).toHaveAttribute("data-workbench-inspector-view", "draft");
  const review = inspector.locator(".workbench-draft-review-list");
  const retainedPin = review.locator('[data-workbench-setup-pin-remove-id="aih/playwright"]');
  await expect(retainedPin).toHaveAccessibleName("Remove saved catalog request for Playwright");
  await expect(review).toContainText(
    "This saved catalog entry is retained for compatibility. Developer tool setup owns new choices for this tool.",
  );
  await inspector.locator('[data-workbench-panel-view="exposure"]').click();
  const overview = inspector.locator("[data-workbench-exposure-overview]");
  const retainedRequest = overview.locator('[data-workbench-exposure-request-id="aih/playwright"]');
  await expect(retainedRequest).toBeVisible();
  const beforeInspect = await preview.inputValue();
  await retainedRequest.locator('[data-workbench-exposure-inspect-id="aih/playwright"]').click();
  await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", "aih/playwright");
  await expect(inspector.locator("[data-workbench-declaration]")).toBeVisible();
  await expect(inspector.locator("[data-workbench-checks]")).toBeVisible();
  await expect(preview).toHaveValue(beforeInspect);

  await writeFile(
    testInfo.outputPath("developer-tool-catalog-browser-receipt.json"),
    JSON.stringify({ errors, networkRequests }, null, 2),
  );
  expect(errors).toEqual([]);
  expect(networkRequests).toEqual([]);
});
