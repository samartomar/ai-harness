import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./fixture.js";

test.use({ artifact: "packed-policy-workbench.html" });
test("one installed Core version refreshes a source and preserves old browser policy pins", async ({
  page,
  workbench,
}, testInfo) => {
  test.setTimeout(90_000);
  const fixtureDirectory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
  if (!fixtureDirectory) throw new Error("Missing packed fixture directory");
  const cli = resolve(fixtureDirectory, "packed-consumer/node_modules/@aihq/core/dist/cli.js");
  const fixture = testInfo.outputPath("source-data-consumer");
  await mkdir(fixture, { recursive: true });
  const preparation = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/prepare-workbench-source-data-fixture.ts", fixture],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  expect(preparation.status, preparation.stderr || preparation.stdout).toBe(0);
  const env = { ...process.env, AIH_WORKBENCH_DATA: resolve(fixture, "store") };
  const commandTimings: Array<{ command: string; wallMs: number }> = [];
  const invoke = (args: string[], extraEnv: Record<string, string> = {}) => {
    const started = performance.now();
    const result = spawnSync(process.execPath, args, {
      cwd: fixture,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    commandTimings.push({ command: args.slice(1).join(" "), wallMs: performance.now() - started });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return result.stdout;
  };
  const invokeAsync = (
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{
    command: string;
    failure?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
    stderr: string;
    stdout: string;
    wallMs: number;
  }> =>
    new Promise((complete) => {
      const started = performance.now();
      const child = spawn(process.execPath, args, {
        cwd,
        env: { ...env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const maxBuffer = 8 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: Error | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;
      const terminate = (error: Error) => {
        if (failure !== undefined) return;
        failure = error;
        if (!child.killed) child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000);
      };
      timeout = setTimeout(() => {
        terminate(new Error("Installed Workbench command timed out after 30000ms"));
      }, 30_000);
      const append = (stream: "stdout" | "stderr", value: Buffer) => {
        if (failure !== undefined) return;
        if (stream === "stdout") {
          stdoutBytes += value.length;
          stdout += value.toString("utf8");
          if (stdoutBytes > maxBuffer)
            terminate(new Error("Installed Workbench command stdout exceeds its byte budget"));
          return;
        }
        stderrBytes += value.length;
        stderr += value.toString("utf8");
        if (stderrBytes > maxBuffer)
          terminate(new Error("Installed Workbench command stderr exceeds its byte budget"));
      };
      child.stdout.on("data", (value: Buffer) => append("stdout", value));
      child.stderr.on("data", (value: Buffer) => append("stderr", value));
      child.once("error", terminate);
      child.once("close", (status, signal) => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        complete({
          command: args.slice(1).join(" "),
          ...(failure === undefined ? {} : { failure }),
          signal,
          status,
          stderr,
          stdout,
          wallMs: performance.now() - started,
        });
      });
    });
  const expectAsyncSuccess = (
    result: Awaited<ReturnType<typeof invokeAsync>>,
    command = result.command,
  ) => {
    commandTimings.push({ command, wallMs: result.wallMs });
    expect(
      result.failure?.message ?? result.status,
      result.failure?.message ?? (result.stderr || result.stdout),
    ).toBe(0);
    return result.stdout;
  };
  const version = invoke([cli, "--version"]);
  const codeDigest = async () => {
    const hash = createHash("sha256");
    for (const file of (await readdir(dirname(cli)))
      .filter((name) => /\.(c?js)$/.test(name))
      .sort())
      hash.update(file).update(await readFile(resolve(dirname(cli), file)));
    return hash.digest("hex");
  };
  const beforeCode = await codeDigest();
  const sourceBefore = await page.evaluate(
    () =>
      (
        window as unknown as {
          __aihWorkbenchModel: {
            workbenchBundle: { sources: Record<string, { revision: { id: string } }> };
          };
        }
      ).__aihWorkbenchModel.workbenchBundle.sources["source:mattpocock"]!.revision.id,
  );
  await page.locator('[data-workbench-source-tab="source:mattpocock"]').click();
  await page
    .locator(
      'article[data-workbench-asset-id="mattpocock/skill:tdd"] button[data-workbench-row-action]',
    )
    .click();
  const oldPolicy = await page.locator("#config-preview").inputValue();
  await writeFile(resolve(fixture, "old-policy.json"), oldPolicy, { flag: "wx" });
  for (const suffix of ["one", "two"]) {
    const imported = JSON.parse(
      invoke([cli, "policy", "data", "import", "--apply", "--input", `signed-${suffix}.json`]),
    );
    expect(imported.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
  const oldPolicyPath = resolve(fixture, "old-policy.json");
  const historicalAdministrator = resolve(fixture, "historical-administrator");
  const currentUiAdministrator = resolve(fixture, "current-ui-administrator");
  const historicalHtml = resolve(historicalAdministrator, "historical.html");
  const currentHtml = resolve(currentUiAdministrator, "current.html");
  await Promise.all([
    mkdir(historicalAdministrator, { recursive: true }),
    mkdir(currentUiAdministrator, { recursive: true }),
  ]);
  const [historicalResult, uiResult] = await Promise.all([
    invokeAsync(
      [
        cli,
        "policy",
        "generate",
        "--apply",
        "--policy-input",
        oldPolicyPath,
        "--out",
        historicalHtml,
      ],
      historicalAdministrator,
    ),
    invokeAsync(
      [
        resolve(fixtureDirectory, "packed-ui-smoke.mjs"),
        cli,
        pathToFileURL(resolve(fixtureDirectory, "packed-ui-browser-preload.mjs")).href,
        currentHtml,
      ],
      currentUiAdministrator,
    ),
  ]);
  expectAsyncSuccess(historicalResult);
  const ui = JSON.parse(expectAsyncSuccess(uiResult));
  expect(ui.catalogSourceRevisions["source:mattpocock"]).toBe("f".repeat(40));
  await page.goto(pathToFileURL(currentHtml).href);
  await page.locator('[data-workbench-source-tab="source:mattpocock"]').click();
  await page
    .locator(
      'article[data-workbench-asset-id="mattpocock/skill:tdd"] button[data-workbench-row-action]',
    )
    .click();
  const newPolicy = await page.locator("#config-preview").inputValue();
  expect(JSON.parse(newPolicy).authoringSelections.roots[0]).toMatchObject({
    assetId: "mattpocock/skill:tdd",
    sourceRevisionId: "f".repeat(40),
    contentDigest: `sha256:${"e".repeat(64)}`,
  });
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  await (await downloadEvent).saveAs(resolve(fixture, "new-policy.json"));
  const newPolicyPath = resolve(fixture, "new-policy.json");
  const oldValidationAdministrator = resolve(fixture, "old-validation-administrator");
  const newValidationAdministrator = resolve(fixture, "new-validation-administrator");
  const exportVerificationAdministrator = resolve(fixture, "export-verification-administrator");
  await Promise.all([
    mkdir(oldValidationAdministrator, { recursive: true }),
    mkdir(newValidationAdministrator, { recursive: true }),
    mkdir(exportVerificationAdministrator, { recursive: true }),
  ]);
  const [oldValidationResult, newValidationResult, consumptionResult] = await Promise.all([
    invokeAsync(
      [cli, "policy", "validate", fixture, "--json", "--no-log"],
      oldValidationAdministrator,
      { AIH_ORG_POLICY: oldPolicyPath },
    ),
    invokeAsync(
      [cli, "policy", "validate", fixture, "--json", "--no-log"],
      newValidationAdministrator,
      { AIH_ORG_POLICY: newPolicyPath },
    ),
    invokeAsync(
      [
        "--import",
        "tsx",
        resolve("tools/verify-workbench-export.ts"),
        oldPolicyPath,
        "mattpocock/skill:tdd",
        newPolicyPath,
        "mattpocock/skill:tdd",
      ],
      exportVerificationAdministrator,
    ),
  ]);
  const validations = [
    ["old-policy.json", oldValidationResult],
    ["new-policy.json", newValidationResult],
  ] as const;
  for (const [file, result] of validations) {
    const validation = expectAsyncSuccess(result);
    await testInfo.attach(`${file}-installed-validation`, {
      body: validation,
      contentType: "application/json",
    });
  }
  expectAsyncSuccess(consumptionResult, "verify both exported policies");
  await page.goto(pathToFileURL(historicalHtml).href);
  const restored = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(restored.authoringSelections).toEqual(JSON.parse(oldPolicy).authoringSelections);
  expect(restored.authoringSelections.roots[0].sourceRevisionId).toBe(sourceBefore);
  expect(restored.governance).toEqual(JSON.parse(oldPolicy).governance);
  expect(await codeDigest()).toBe(beforeCode);
  expect(workbench.networkRequests).toEqual([]);
  const timingPath = testInfo.outputPath("source-update-command-timings.json");
  await writeFile(timingPath, JSON.stringify(commandTimings, null, 2));
  await testInfo.attach("source-update-command-timings", {
    path: timingPath,
    contentType: "application/json",
  });
  await testInfo.attach("same-core-refresh", {
    body: JSON.stringify({
      version: version.trim(),
      executableDigest: beforeCode,
      oldRevision: sourceBefore,
      newRevision: "f".repeat(40),
      policySelectionsPreserved: true,
      rescans: 0,
      fixtureOnly: true,
    }),
    contentType: "application/json",
  });
});
test("published source evidence survives installed browser export and inert policy consumption", async ({
  page,
  workbench,
}, testInfo) => {
  const assetId = "mattpocock/skill:tdd";
  await page.locator('[data-workbench-source-tab="source:mattpocock"]').click();
  const row = page.locator(`article[data-workbench-asset-id="${assetId}"]`);
  await expect(row).toBeVisible();
  await row.locator("button[data-workbench-expand-id]").click();
  await expect(row.locator(".workbench-evidence-sheet")).toContainText("Reported result:");
  await row.locator("button[data-workbench-detail-id]").click();
  const detail = JSON.parse(
    (await page.locator(".workbench-detail-advanced pre").textContent()) ?? "{}",
  );
  expect(detail.scannerReports.length).toBeGreaterThan(0);
  expect(
    detail.scannerReports.some(
      (report: { scan: { outcome: string } }) => report.scan.outcome === "pass",
    ),
  ).toBe(true);
  expect(detail.catalogQualification.text).toContain(
    "samartomar/aih-catalog@b019b4e9d6260915a49d177bcc22b58518305dd4",
  );
  expect(detail.catalogQualification.text).toContain("does not grant organization approval");
  expect(["current", "expired"]).toContain(detail.catalogQualification.state);
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await row.locator("button[data-workbench-row-action]").click();
  const expected = await page.locator("#config-preview").inputValue();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadEvent;
  const fixture = testInfo.outputPath("policy-consumer");
  await mkdir(fixture, { recursive: true });
  const path = resolve(fixture, "aih-org-policy.json");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(expected);
  const consumption = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/verify-workbench-export.ts", path, assetId],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  expect(consumption.status, consumption.stderr || consumption.stdout).toBe(0);
  expect(consumption.stdout).toContain("WORKBENCH_EXPORT_CONSUMPTION_VERIFIED");
  const preparedDirectory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
  if (!preparedDirectory) throw new Error("Missing installed fixture");
  const cli = resolve(preparedDirectory, "packed-consumer/node_modules/@aihq/core/dist/cli.js");
  const validation = spawnSync(
    process.execPath,
    [cli, "policy", "validate", fixture, "--json", "--no-log"],
    {
      cwd: fixture,
      env: { ...process.env, AIH_ORG_POLICY: path },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  expect(validation.status, validation.stderr || validation.stdout).toBe(0);
  await testInfo.attach("installed-policy-validation", {
    body: validation.stdout,
    contentType: "application/json",
  });
  expect(workbench.networkRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("published-evidence.png"), fullPage: true });
});
test("installed package generates a complete offline artifact with usable export", async ({
  page,
  workbench,
}, testInfo) => {
  const fixtureDirectory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
  if (!fixtureDirectory) throw new Error("Missing packed fixture directory");
  const receipt = JSON.parse(
    await readFile(resolve(fixtureDirectory, "package-receipt.json"), "utf8"),
  );
  const receiptPath = testInfo.outputPath("packed-preparation.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  await testInfo.attach("packed-preparation", {
    path: receiptPath,
    contentType: "application/json",
  });
  expect(receipt.ui).toMatchObject({
    url: expect.stringMatching(
      /^http:\/\/127\.0\.0\.1:\d+\/aih-policy-workbench\.html#[a-f0-9]{64}$/u,
    ),
    catalogSourceIds: expect.arrayContaining([
      "source:aih-core",
      "source:ecc",
      "source:superpowers",
    ]),
    browserOpenRequested: true,
    adminWrites: [],
  });
  expect(receipt.ui.initialRows).toBeLessThanOrEqual(50);
  expect(
    (receipt.ui.shutdown.code === 0 && receipt.ui.shutdown.signal === null) ||
      (receipt.ui.shutdown.code === null && receipt.ui.shutdown.signal === "SIGTERM"),
  ).toBe(true);
  await testInfo.attach("installed-ui-launcher", {
    body: JSON.stringify(receipt.ui, null, 2),
    contentType: "application/json",
  });
  expect(workbench.networkRequests).toEqual([]);
  const initialRows = page.locator("article[data-workbench-asset-id]");
  // The package retains historical pins, but Ponytail is not offered in the UI.
  await expect(page.locator('[data-workbench-source-tab="source:ponytail"]')).toHaveCount(0);
  await expect(
    page.locator('#workbench-source-filter option[value="source:ponytail"]'),
  ).toHaveCount(0);
  await expect(page.locator("#framework-rows")).not.toContainText("DietrichGebert/ponytail");
  for (const sourceId of await page
    .locator("[data-workbench-source-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-workbench-source-tab")))) {
    await page.locator(`[data-workbench-source-tab="${sourceId}"]`).click();
    await page.getByRole("searchbox", { name: "Search catalog" }).fill("ponytail");
    await expect(page.locator('article[data-workbench-asset-id^="ponytail/"]')).toHaveCount(0);
    await page.locator(".workbench-starting-points").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await expect(
      page.locator('[data-workbench-template-detail-id="template:ponytail/methodology"]'),
    ).toHaveCount(0);
  }
  await page.getByRole("searchbox", { name: "Search catalog" }).fill("");
  await page.locator('[data-workbench-source-tab="source:aih-core"]').click();
  expect(await initialRows.count()).toBeLessThanOrEqual(50);
  await expect(page.locator("#preset-select, #skill-rows, #agent-rows, #mcp-rows")).toHaveCount(0);
  const shape = await page.evaluate(() => {
    const model = (window as unknown as { __aihWorkbenchModel: Record<string, unknown> })
      .__aihWorkbenchModel;
    const catalog = model.catalog as Record<string, unknown>;
    const bundle = model.workbenchBundle as {
      assets: Record<string, { sourceId: string; kind: string }>;
    };
    const activeSource = document.querySelector<HTMLElement>(
      '[data-workbench-source-tab][aria-pressed="true"]',
    )?.dataset.workbenchSourceTab;
    return {
      assetCount: Object.keys(bundle.assets).length,
      activeSourceCount: Object.values(bundle.assets).filter(
        (asset) => asset.sourceId === activeSource,
      ).length,
      sourceIsolated: [
        ...document.querySelectorAll<HTMLElement>("article[data-workbench-asset-id]"),
      ].every((row) => {
        const assetId = row.dataset.workbenchAssetId;
        return assetId !== undefined && bundle.assets[assetId]?.sourceId === activeSource;
      }),
      organizationKinds: Object.values(bundle.assets)
        .filter((asset) => asset.sourceId === "source:packed-organization")
        .map((asset) => asset.kind)
        .sort(),
      legacyArrays: ["assets", "mcp", "hookRegistry"].filter((key) => key in catalog),
    };
  });
  expect(shape.assetCount).toBeGreaterThan(100);
  expect(shape.activeSourceCount).toBeGreaterThan(0);
  await expect(initialRows).toHaveCount(Math.min(50, shape.activeSourceCount));
  expect(shape.sourceIsolated).toBe(true);
  expect(shape.legacyArrays).toEqual([]);
  expect(shape.organizationKinds).toEqual(["agent", "mcp", "skill"]);
  await page.locator('[data-workbench-source-tab="source:packed-organization"]').click();
  await page.getByRole("searchbox", { name: "Search catalog" }).fill("Packed organization MCP");
  await expect(page.locator("article[data-workbench-asset-id]")).toHaveCount(1);
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "Packed organization MCP",
  );
  await page.locator("button[data-workbench-row-action]").click();
  const requested = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(requested.authoringSelections.roots).toEqual([]);
  expect(requested.authoringSelections.requests).toHaveLength(1);
  expect(requested.authoringSelections.requests[0].sourceId).toBe("source:packed-organization");
  await page.getByRole("searchbox", { name: "Search catalog" }).fill("Packed organization agent");
  await expect(page.locator("article[data-workbench-asset-id]")).toHaveCount(1);
  await page.locator("button[data-workbench-row-action]").click();
  const initial = await page.locator("#config-preview").inputValue();
  const policy = JSON.parse(initial);
  expect(policy.schemaVersion).toBe(3);
  expect(policy.authoringSelections.roots).toHaveLength(1);
  expect(policy.authoringSelections.roots[0].sourceId).toBe("source:packed-organization");
  expect(policy.authoringSelections.roots[0].resolvedItems).toHaveLength(2);
  expect(policy.authoringSelections.requests).toEqual(requested.authoringSelections.requests);
  expect(policy.authoringSelections.drafts).toEqual([]);
  expect(policy.authoringSources).toHaveLength(1);
  const transported = policy.authoringSources[0];
  expect(transported.kind).toBe("organization-manifest");
  const manifestBytes = Buffer.from(transported.bytesBase64, "base64");
  expect(manifestBytes.byteLength).toBe(transported.byteLength);
  expect(JSON.parse(manifestBytes.toString("utf8")).source.id).toBe("source:packed-organization");
  expect(policy.governance.activations).toEqual([]);
  expect(policy.governance.catalog.reviewed).toEqual([]);
  expect(policy.governance.authority.approvals).toEqual([]);

  expect(JSON.parse(initial).references.repoContract).toBe("ai-coding/project.json");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadEvent;
  const path = testInfo.outputPath("packed-policy.json");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(initial);

  // Following an overlap must make its programmatic filter visible to the user.
  await page.locator('[data-workbench-source-tab="source:aih-core"]').click();
  const search = page.getByRole("searchbox", { name: "Search catalog" });
  await search.fill("context7");
  await page.getByRole("button", { name: "Request review for Context7", exact: true }).click();
  await page.locator('[data-workbench-source-tab="source:ecc"]').click();
  await search.fill("context");
  await page.getByRole("button", { name: "Review @aihq/core choice", exact: true }).click();
  await expect(search).toHaveValue("context7");
  await expect(page.locator(".workbench-starting-points")).toBeHidden();
  await expect(page.locator('[data-workbench-source-tab="source:aih-core"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
