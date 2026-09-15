import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const tools = [
  ["code-review-graph", "Code Review Graph"],
  ["codebase-memory-mcp", "Codebase Memory MCP"],
  ["serena", "Serena"],
  ["token-optimizer", "Token Optimizer"],
  ["context7", "Context7"],
  ["markitdown", "MarkItDown CLI"],
] as const;

for (const [excludedId, excludedLabel] of [
  ["context7", "Context7"],
  ["markitdown", "MarkItDown CLI"],
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
    await page.goto(pathToFileURL(resolve(directory, "author.html")).href);

    const rows = page.locator("[data-developer-tool-id]");
    await expect(rows).toHaveCount(tools.length);
    for (const [id, label] of tools) {
      const row = page.locator(`[data-developer-tool-id="${id}"]`);
      await expect(row).toContainText(label);
      await expect(row).toContainText("Selected — pending setup");
    }
    expect(JSON.parse(await page.locator("#config-preview").inputValue())).not.toHaveProperty(
      "developerTools",
    );

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
    await page.goto(pathToFileURL(resolve(directory, "excluded-reopened.html")).href);
    await expect(excludedRow).toContainText("Excluded by policy");
    expect(JSON.parse(await page.locator("#config-preview").inputValue()).developerTools).toEqual(
      excludedPolicy.developerTools,
    );

    invoke(["policy", "generate", "--out", "excluded-import-target.html", "--apply", "--json"]);
    await page.goto(pathToFileURL(resolve(directory, "excluded-import-target.html")).href);
    await page.locator("#policy-file").setInputFiles(excludedExported);
    await expect
      .poll(
        async () => JSON.parse(await page.locator("#config-preview").inputValue()).developerTools,
      )
      .toEqual(excludedPolicy.developerTools);
    await expect(excludedRow).toContainText("Excluded by policy");

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
    await page.goto(pathToFileURL(resolve(directory, "reopened.html")).href);
    await expect(rows).toHaveCount(tools.length);
    for (const [id] of tools)
      await expect(page.locator(`[data-developer-tool-id="${id}"]`)).toContainText("Not selected");

    invoke(["policy", "generate", "--out", "import-target.html", "--apply", "--json"]);
    await page.goto(pathToFileURL(resolve(directory, "import-target.html")).href);
    await page.locator("#policy-file").setInputFiles(emptyExported);
    await expect
      .poll(
        async () => JSON.parse(await page.locator("#config-preview").inputValue()).developerTools,
      )
      .toEqual({ selected: [] });

    await writeFile(
      testInfo.outputPath("developer-tool-browser-receipt.json"),
      JSON.stringify({ commands, errors, networkRequests }, null, 2),
    );
    expect(errors).toEqual([]);
    expect(networkRequests).toEqual([]);
  });
}
