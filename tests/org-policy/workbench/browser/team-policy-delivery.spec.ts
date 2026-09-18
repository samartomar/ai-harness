import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * NEW-SHELL-PLAN.md S6: allowed CLIs and posture moved to the new shell's
 * organization screen; the Compose tab became the nav rail. Assertions unchanged.
 */

test("authors independent required practices in the browser and reopens exact exports through the public CLI", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = testInfo.outputPath("fictional-adopters");
  await mkdir(directory, { recursive: true });
  const cli = resolve("dist/cli.js");
  const commands: Array<{ argv: string[]; code: number | null; stdout: string; stderr: string }> =
    [];
  const invoke = (args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        AIH_WORKBENCH_DATA: resolve(directory, "source-data"),
        AIH_WORKBENCH_VERIFIER_HOME: resolve(directory, "verifier"),
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 40_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    commands.push({
      argv: args,
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
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
  const cases = [
    {
      name: "harbor-node-api",
      required: "tdd-workflow",
      excluded: "frontend-patterns",
      targets: ["codex", "opencode"],
    },
    {
      name: "cedar-security-service",
      required: "security-review",
      excluded: "tdd-workflow",
      targets: ["claude", "cursor", "kimi", "kiro"],
    },
  ];
  const exports: Record<string, string> = {};
  for (const adopter of cases) {
    await page.goto(pathToFileURL(resolve(directory, "author.html")).href);
    // This journey authors independent practices from a deliberate empty policy.
    await page.locator("#policy-file").setInputFiles({
      name: "practice-only.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          minimumPosture: "vibe",
          references: { repoContract: "ai-coding/project.json" },
          governance: {
            policyVersion: "1",
            catalog: { reviewed: [], custom: [] },
            activations: [],
            authority: { approvals: [], decisions: [] },
            externalCuration: [],
            externalSelections: [],
            eccMcpApprovals: [],
            hookRegistrations: [],
          },
        }),
      ),
    });
    await expect
      .poll(
        async () => JSON.parse(await page.locator("#config-preview").inputValue()).schemaVersion,
      )
      .toBe(2);
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    const nav = page.getByRole("navigation", { name: "Workbench screens" });
    await nav.getByRole("button", { name: "Organization", exact: true }).click();
    const sanctioned = page.locator("[data-sanctioned-cli]");
    for (let index = 0; index < (await sanctioned.count()); index++) {
      const control = sanctioned.nth(index);
      const target = await control.getAttribute("data-sanctioned-cli");
      const selected = (await control.getAttribute("aria-pressed")) === "true";
      if (selected !== adopter.targets.includes(target ?? "")) await control.click();
    }
    await page.locator("#posture").selectOption("enterprise");
    await nav.getByRole("button", { name: "Sources & Catalogs", exact: true }).click();
    await page.locator('[data-workbench-source-tab="source:ecc"]').click();
    const search = page.getByRole("searchbox", { name: "Search catalog" });
    const requiredId = `ecc/skill:${adopter.required}`;
    const excludedId = `ecc/skill:${adopter.excluded}`;
    await search.fill(adopter.required);
    await page.locator(`button[data-workbench-asset-id="${requiredId}"]`).click();
    await page
      .locator(`button.workbench-row-title[data-workbench-expand-id="${requiredId}"]`)
      .click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", requiredId);
    await expect(inspector.locator("#workbench-detail-title")).toBeVisible();
    await inspector.locator(".workbench-item-technical > summary").click();
    await inspector.locator(`button[data-workbench-detail-id="${requiredId}"]`).click();
    await expect(inspector).toContainText("instruction guidance");
    await page.keyboard.press("Escape");
    await inspector.locator('[data-workbench-panel-view="exposure"]').click();
    await expect(inspector.locator("[data-workbench-exposure-overview]")).toBeVisible();
    await page
      .locator(`button.workbench-row-title[data-workbench-expand-id="${requiredId}"]`)
      .click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", requiredId);
    await inspector.locator(".workbench-item-technical > summary").click();
    await inspector.getByText("More options", { exact: true }).click();
    const beforeRefusal = await page.locator("#config-preview").inputValue();
    await page.locator(`button[data-workbench-exclusion-id="${requiredId}"]`).click();
    await expect(page.locator("#framework-rows .error")).toContainText("requires excluded asset");
    await expect(page.locator("#config-preview")).toHaveValue(beforeRefusal);
    await search.fill(adopter.excluded);
    await page
      .locator(`button.workbench-row-title[data-workbench-expand-id="${excludedId}"]`)
      .click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", excludedId);
    await expect(inspector.locator("#workbench-detail-title")).toBeVisible();
    await inspector.locator(".workbench-item-technical > summary").click();
    await inspector.getByText("More options", { exact: true }).click();
    await page.locator(`button[data-workbench-exclusion-id="${excludedId}"]`).click();
    const policyBytes = await page.locator("#config-preview").inputValue();
    const policy = JSON.parse(policyBytes);
    expect(policy.minimumPosture).toBe("enterprise");
    expect(policy.governance.supportedClis.slice().sort()).toEqual(adopter.targets.slice().sort());
    expect(
      policy.authoringSelections.roots.map((root: { assetId: string }) => root.assetId),
    ).toContain(requiredId);
    expect(
      policy.authoringSelections.exclusions.map((item: { assetId: string }) => item.assetId),
    ).toContain(excludedId);
    expect(
      policy.governance.externalSelections[0].items.map((item: { id: string }) => item.id),
    ).toContain(`skill:${adopter.required}`);
    await page.screenshot({ path: testInfo.outputPath(`${adopter.name}.png`), fullPage: true });
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#download").click();
    const download = await downloadEvent;
    const exportedPath = resolve(directory, `${adopter.name}.json`);
    await download.saveAs(exportedPath);
    const downloaded = await readFile(exportedPath, "utf8");
    expect(JSON.parse(downloaded)).toEqual(policy);
    exports[adopter.name] = downloaded;
    invoke([
      "policy",
      "generate",
      "--policy-input",
      exportedPath,
      "--out",
      `${adopter.name}-reopened.html`,
      "--apply",
      "--json",
    ]);
    await page.goto(pathToFileURL(resolve(directory, `${adopter.name}-reopened.html`)).href);
    expect(JSON.parse(await page.locator("#config-preview").inputValue())).toEqual(policy);
    await page.reload();
    expect(JSON.parse(await page.locator("#config-preview").inputValue())).toEqual(policy);
    // Importing into another fresh artifact uses the supported browser input too.
    await page.goto(pathToFileURL(resolve(directory, "author.html")).href);
    await page.locator("#policy-file").setInputFiles(exportedPath);
    await expect
      .poll(async () => JSON.parse(await page.locator("#config-preview").inputValue()))
      .toEqual(policy);
  }
  expect(exports[cases[0]!.name]).not.toBe(exports[cases[1]!.name]);
  expect(errors).toEqual([]);
  expect(networkRequests).toEqual([]);
  const receiptPath = testInfo.outputPath("public-cli-authoring.json");
  await writeFile(
    receiptPath,
    JSON.stringify({ commands, cases, errors, networkRequests }, null, 2),
  );
  await testInfo.attach("public-cli-authoring", {
    path: receiptPath,
    contentType: "application/json",
  });
});
