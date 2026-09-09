import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./fixture.js";

test.use({ artifact: "journeys-compact.html" });

test("opens offline and keeps exact prepared evidence separate from permission across expiry", async ({
  page,
  workbench,
}) => {
  expect(workbench.path).toContain("aih-policy-workbench.html");
  // A caught eval probe still violates CSP. Exercise the real bundle with no
  // browser storage and no permission to generate code dynamically.
  const strictHtml = (await readFile(workbench.path, "utf8")).replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">`,
  );
  await writeFile(workbench.path, strictHtml);
  await page.addInitScript(() => {
    const probe = { storageReads: 0, violations: [] as string[] };
    Object.defineProperty(window, "__aihBrowserBoundaryProbe", {
      value: probe,
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      probe.violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, {
        get() {
          probe.storageReads++;
          throw new DOMException(
            "Access to storage is not allowed from this context.",
            "SecurityError",
          );
        },
      });
    }
  });
  await page.goto(pathToFileURL(workbench.path).href);
  await expect(
    page.locator(
      "input:not([id]):not([name]),select:not([id]):not([name]),textarea:not([id]):not([name])",
    ),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  const guide = page.locator("#adoption-recipe-panel");
  const guideToggle = page.locator("#adoption-recipe-toggle");
  await expect(guide).toBeHidden();
  await guideToggle.focus();
  await page.keyboard.press("Enter");
  await expect(guide).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close adoption recipe", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(guideToggle).toBeFocused();
  await guideToggle.click();
  await page.mouse.move(1, 880);
  await expect(guide).toBeHidden();
  for (const view of ["Compose", "Authoring"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    const headings = page.locator("[data-group]:visible");
    for (let index = 0; index < (await headings.count()); index++) {
      const heading = headings.nth(index);
      if ((await heading.getAttribute("aria-expanded")) === "true") await heading.click();
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await heading.focus();
      await page.keyboard.press("Enter");
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      const bodyId = (await heading.getAttribute("aria-controls"))!.split(" ")[0]!;
      await expect(page.locator(`[id="${bodyId}"]`)).toBeVisible();
      await page.keyboard.press("Space");
      if ((await heading.getAttribute("aria-expanded")) === "true") await heading.click();
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(`[id="${bodyId}"]`)).toBeHidden();
    }
  }
  const editor = page.locator("#curation-editor");
  await editor.locator("summary").click();
  await expect(editor).toHaveAttribute("open", "");
  await editor.locator("summary").click();
  await expect(editor).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const beforeReport = await page.locator("#config-preview").inputValue();
  await page.locator('[data-workbench-source-tab="source:ecc"]').click();
  await page.locator("button[data-workbench-expand-id]").first().click();
  const packagedReport = page.locator(".workbench-evidence-sheet");
  await expect(packagedReport).toContainText("Reported result:");
  await expect(packagedReport).toContainText("complete coverage");
  await expect(packagedReport).toContainText("covered by a broader source report");
  await expect(packagedReport.locator(".workbench-report-analyzers li").first()).toBeVisible();
  await expect(packagedReport).toContainText("Report findings");
  await expect(packagedReport).toHaveAttribute("data-workbench-evidence-state", "verified");
  await expect(packagedReport).toContainText(
    "Core verified the attached evidence for this version.",
  );
  await expect(packagedReport).toContainText("Repackaging does not renew this date.");
  await expect(packagedReport).not.toContainText("No current Core verification interval");
  await expect(packagedReport).not.toContainText("No verified qualification is established");
  await expect(page.locator(".workbench-source-review")).not.toContainText("0 currently verified");
  await expect(page.locator("#config-preview")).toHaveValue(beforeReport);
  expect(await page.evaluate(() => Reflect.get(window, "__aihBrowserBoundaryProbe"))).toEqual({
    storageReads: 0,
    violations: [],
  });
  const policy = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(policy.references.repoContract).toBe("ai-coding/project.json");
  expect(policy.governance.aihMcpRequests).toBeUndefined();
  await expect(page.locator("#download")).toBeEnabled();
  await page.clock.install({ time: new Date("2026-09-04T12:30:00Z") });
  await page.goto(
    pathToFileURL(resolve(process.env.AIH_WORKBENCH_FIXTURE_DIR!, "synthetic-evidence.html")).href,
  );
  await page.locator('[data-workbench-source-tab="source:a"]').click();
  const search = page.getByRole("searchbox", { name: "Search catalog" });
  await search.fill("mcp:request");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "Scan passed · complete coverage",
  );
  await expect(page.locator(".workbench-draft-counts")).toContainText("Controls 0");
  await search.fill("inspect-item");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "Findings to review",
  );
  await page.locator('button[data-workbench-expand-id="inspect-item"]').click();
  const passWithFindings = page.locator(
    'article[data-workbench-asset-id="inspect-item"] .workbench-evidence-sheet',
  );
  await expect(passWithFindings).toHaveAttribute("data-workbench-evidence-tone", "warning");
  await expect(passWithFindings).toContainText("Review outbound access in shared configuration.");
  await expect(passWithFindings).toContainText("broader source report");
  await search.fill("skill:root");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "Scan found concerns",
  );
  await search.fill("mcp:request");
  await page.locator('button[data-workbench-expand-id="mcp:request"]').click();
  await page.locator('button[data-workbench-detail-id="mcp:request"]').click();
  const evidenceDetail = page.locator("[data-workbench-detail]");
  await expect(evidenceDetail).toContainText("Prepared evidence is verified");
  await evidenceDetail.locator("summary").click();
  await expect(evidenceDetail.locator("details")).toHaveAttribute("open", "");
  await page.clock.fastForward(30 * 60 * 1000);
  await expect(evidenceDetail).toContainText("Scan report needs refreshing");
  await expect(evidenceDetail).not.toContainText("Prepared evidence is verified");
  await expect(page.locator(".workbench-source-review")).toContainText("0 currently verified");
  await expect(evidenceDetail.locator("details")).toHaveAttribute("open", "");
  await expect(evidenceDetail.locator("summary")).toBeFocused();
  await expect(
    page.locator('article[data-workbench-asset-id="mcp:request"] .workbench-evidence-sheet'),
  ).toContainText("Scan report needs refreshing");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "Scan report needs refreshing",
  );
  await expect(page.locator("article[data-workbench-asset-id]")).not.toContainText("pass/complete");
  await page.keyboard.press("Escape");
  await search.fill("skill:root");
  await page.locator('button[data-workbench-expand-id="skill:root"]').click();
  const historical = page.locator(
    'article[data-workbench-asset-id="skill:root"] .workbench-evidence-sheet',
  );
  await expect(historical).toHaveAttribute("data-workbench-evidence-tone", "neutral");
  await expect(historical).toContainText("Historical reported result: Concerns found");
  await expect(historical).toContainText("Historical report findings");
  const authored = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(authored.governance.catalog.reviewed).toEqual([]);
  expect(authored.governance.authority.approvals).toEqual([]);
});

test("imports legacy policy, rolls back invalid input, and downloads exact bytes", async ({
  page,
  workbench,
}, testInfo) => {
  expect(workbench.networkRequests).toEqual([]);
  const legacy = {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      externalCuration: [],
      externalSelections: [],
      aihMcpRequests: [{ id: "context7", clarification: "Requested by: administrator" }],
    },
  };
  const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
  await page.locator("#policy-file").setInputFiles({
    name: "legacy-policy.json",
    mimeType: "application/json",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator("#announcement")).toContainText("Policy imported");
  await expect(page.locator("#config-preview")).toHaveValue(bytes);
  await page.locator("#policy-file").setInputFiles({
    name: "invalid-policy.json",
    mimeType: "application/json",
    buffer: Buffer.from(bytes.replace("{", '{"schemaVersion":2,')),
  });
  await expect(page.locator("#announcement")).toContainText("rejected");
  await expect(page.locator("#config-preview")).toHaveValue(bytes);
  const pin = {
    assetId: "test:root",
    sourceId: "source:test",
    sourceRevisionId: "revision:1",
    contentDigest: "sha256:" + "a".repeat(64),
  };
  const state = {
    selectionVersion: "workbench-selection/v1",
    roots: [],
    exclusions: [],
    requests: [],
    drafts: [],
  };
  const versioned = {
    ...legacy,
    schemaVersion: 3,
    minimumCoreVersion: "0.6.0",
    authoringSelections: state,
  };
  const exclusion = { ...pin, origin: { kind: "administrator" } };
  const root = {
    ...pin,
    origin: { kind: "administrator" },
    mode: "select",
    includeOptionalMembers: false,
    resolvedItems: [pin],
  };
  const { minimumCoreVersion: ignoredMinimum, ...missingMinimum } = versioned;
  expect(ignoredMinimum).toBe("0.6.0");
  const invalidImports = [
    missingMinimum,
    { ...versioned, minimumCoreVersion: "9.0.0" },
    { ...versioned, authoringSelections: { ...state, roots: [root, root] } },
    {
      ...versioned,
      authoringSelections: { ...state, exclusions: [exclusion, exclusion] },
    },
    {
      ...versioned,
      authoringSelections: {
        ...state,
        roots: [{ ...root, resolvedItems: [{ ...pin, assetId: "z:last" }, pin] }],
      },
    },
  ];
  const genericBefore = await page.locator("#framework-rows").textContent();
  for (const invalid of invalidImports) {
    await page.locator("#policy-file").setInputFiles({
      name: "invalid-v3.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(invalid)),
    });
    await expect(page.locator("#announcement")).toContainText("rejected");
    await expect(page.locator("#config-preview")).toHaveValue(bytes);
    expect(await page.locator("#framework-rows").textContent()).toBe(genericBefore);
  }

  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.json$/u);
  const path = testInfo.outputPath("downloaded-policy.json");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(bytes);
  const staleRoots = await page.evaluate(() => {
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
                authoring: { action: string };
              }
            >;
          };
        };
      }
    ).__aihWorkbenchModel;
    return Object.values(model.workbenchBundle.assets)
      .filter((asset) => asset.authoring.action === "record-selection")
      .slice(0, 2)
      .map((asset) => {
        const pin = {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: "sha256:" + "0".repeat(64),
        };
        return {
          ...pin,
          mode: "select",
          includeOptionalMembers: false,
          origin: { kind: "administrator" },
          resolvedItems: [pin],
        };
      })
      .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  });
  expect(staleRoots).toHaveLength(2);
  const stalePolicy = {
    ...versioned,
    governance: { ...legacy.governance, aihMcpRequests: undefined },
    authoringSelections: { ...state, roots: staleRoots },
  };
  const importBytes = async (body: string) =>
    page.locator("#policy-file").setInputFiles({
      name: "repair-policy.json",
      mimeType: "application/json",
      buffer: Buffer.from(body),
    });
  await importBytes(JSON.stringify(stalePolicy));
  await expect(page.locator("#framework-rows > .error")).toContainText(/stale/i);
  await page.locator(".workbench-draft-review > summary").click();
  await expect(page.locator(".workbench-draft-review-list")).toContainText(/needs review/i);
  await expect(page.locator(".workbench-draft-review-list [data-workbench-detail-id]")).toHaveCount(
    0,
  );
  await page.locator(".workbench-draft-review > summary").click();
  await page.locator(`[data-workbench-source-tab="${staleRoots[0]!.sourceId}"]`).click();
  await page.getByRole("searchbox", { name: "Search catalog" }).fill(staleRoots[0]!.assetId);
  await page.locator("button[data-workbench-asset-id]").click();
  const intermediate = await page.locator("#config-preview").inputValue();
  expect(JSON.parse(intermediate).authoringSelections.roots).toEqual([staleRoots[1]]);
  await expect(page.locator("#framework-rows > .error")).toContainText(/stale/i);
  const repairDownloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const repairDownload = await repairDownloadEvent;
  const repairPath = testInfo.outputPath("repair-policy.json");
  await repairDownload.saveAs(repairPath);
  expect(await readFile(repairPath, "utf8")).toBe(intermediate);
  await page.reload();
  await importBytes(intermediate);
  await expect(page.locator("#framework-rows > .error")).toContainText(/stale/i);
  await page.locator(`[data-workbench-source-tab="${staleRoots[1]!.sourceId}"]`).click();
  await page.getByRole("searchbox", { name: "Search catalog" }).fill(staleRoots[1]!.assetId);
  await page.locator("button[data-workbench-asset-id]").click();
  const repaired = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(repaired.authoringSelections.roots).toEqual([]);
  expect(repaired.governance.activations).toEqual([]);
  await expect(page.locator("#framework-rows > .error")).toHaveText("");
  const removedPin = (assetId: string) => ({
    assetId,
    sourceId: "source:removed",
    sourceRevisionId: "revision:1",
    contentDigest: "sha256:" + "f".repeat(64),
  });
  const missingRootPin = removedPin("missing:root");
  const missingRequest = {
    ...removedPin("missing:request"),
    origin: { kind: "legacy-unattributed" },
  };
  const missingExclusion = {
    ...removedPin("missing:exclusion"),
    origin: { kind: "administrator" },
  };
  const missingState = {
    ...state,
    roots: [
      {
        ...missingRootPin,
        mode: "select",
        includeOptionalMembers: false,
        origin: { kind: "administrator" },
        resolvedItems: [missingRootPin],
      },
    ],
    requests: [missingRequest],
    exclusions: [missingExclusion],
  };
  await importBytes(JSON.stringify({ ...repaired, authoringSelections: missingState }));
  await expect(page.locator('[aria-label="Saved selections needing review"] button')).toHaveCount(
    3,
  );
  await page.locator('[data-workbench-repair-type="remove-root"]').click();
  const missingIntermediate = await page.locator("#config-preview").inputValue();
  const savedMissing = JSON.parse(missingIntermediate).authoringSelections;
  expect(savedMissing.roots).toEqual([]);
  expect(savedMissing.requests).toEqual([missingRequest]);
  expect(savedMissing.exclusions).toEqual([missingExclusion]);
  await expect(page.locator("#framework-rows > .error")).toContainText(/missing|unknown/i);
  await page.reload();
  await importBytes(missingIntermediate);
  await expect(page.locator('[aria-label="Saved selections needing review"] button')).toHaveCount(
    2,
  );
  await page.locator('[data-workbench-repair-type="remove-request"]').click();
  await expect(page.locator("#framework-rows > .error")).toContainText(/missing|unknown/i);
  await page.locator('[data-workbench-repair-type="remove-exclusion"]').click();
  const completeRepair = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(completeRepair.authoringSelections).toEqual(state);
  expect(completeRepair.governance.activations).toEqual([]);
  const compatibleAssets = await page.evaluate(() => {
    const model = (
      window as unknown as {
        __aihWorkbenchModel: {
          workbenchBundle: {
            assets: Record<
              string,
              {
                id: string;
                sourceId: string;
                kind: string;
                exclusiveSlot?: string;
                authoring: { action: string };
              }
            >;
          };
        };
      }
    ).__aihWorkbenchModel;
    const bySource = new Map<string, string>();
    for (const asset of Object.values(model.workbenchBundle.assets).sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )) {
      if (
        asset.kind === "skill" &&
        !asset.exclusiveSlot &&
        asset.authoring.action === "record-selection"
      )
        bySource.set(asset.sourceId, asset.id);
    }
    const sourceIds = [...bySource.keys()].sort();
    if (sourceIds.length !== 2) throw new Error("expected two additive source fixtures");
    return sourceIds.map((sourceId) => {
      const assetId = bySource.get(sourceId);
      if (assetId === undefined) throw new Error(`missing additive fixture asset: ${sourceId}`);
      return { assetId, sourceId };
    });
  });
  for (const { assetId, sourceId } of compatibleAssets) {
    await page.locator(`[data-workbench-source-tab="${sourceId}"]`).click();
    await page.getByRole("searchbox", { name: "Search catalog" }).fill(assetId);
    await page
      .locator('button[data-workbench-row-action][data-workbench-asset-id="' + assetId + '"]')
      .click();
  }
  const mixedPolicy = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(
    mixedPolicy.authoringSelections.roots.map((root: { sourceId: string }) => root.sourceId).sort(),
  ).toEqual(compatibleAssets.map((asset) => asset.sourceId));
  await page.locator('[data-view-tab="compose"]').click();
  await page.locator('[data-sanctioned-cli="codex"]').click();
  const editedMixed = await page.locator("#config-preview").inputValue();
  expect(JSON.parse(editedMixed).authoringSelections.roots).toEqual(
    mixedPolicy.authoringSelections.roots,
  );
  expect(JSON.parse(editedMixed).governance.supportedClis).toEqual(["codex"]);
  const mixedDownloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const mixedDownload = await mixedDownloadEvent;
  const mixedPath = testInfo.outputPath("mixed-source-policy.json");
  await mixedDownload.saveAs(mixedPath);
  expect(await readFile(mixedPath, "utf8")).toBe(editedMixed);
  const validStrix = {
    enabled: false,
    required: false,
    targetKind: "local-fixture",
    mode: "quick",
    maxBudgetCents: 1,
    maxTurns: 1,
    timeoutMs: 1,
    telemetry: "off",
    imageDigest: "sha256:" + "a".repeat(64),
    allowLiveTargets: false,
    allowMounts: false,
  };
  const withSecurity = {
    ...JSON.parse(editedMixed),
    security: { strix: validStrix },
  };
  await page.evaluate((policy) => {
    (
      window as unknown as {
        __aihPolicyWorkbenchSession: {
          validatePolicy(value: unknown): unknown;
        };
      }
    ).__aihPolicyWorkbenchSession.validatePolicy(policy);
  }, withSecurity);
  for (const invalid of [
    ...["x", 999, 1.5].map((maxTurns) => ({
      ...withSecurity,
      security: { strix: { ...validStrix, maxTurns } },
    })),
    ...["candidate-a", "decision-Bad"].map((decision) => {
      const policy = JSON.parse(editedMixed);
      policy.governance.authority.decisions = [decision];
      return policy;
    }),
    { ...JSON.parse(editedMixed), references: { repoContract: 33 } },
    { ...JSON.parse(editedMixed), unexpectedRoot: true },
    { ...JSON.parse(editedMixed), minimumPosture: "invalid" },
  ]) {
    await importBytes(JSON.stringify(invalid));
    await expect(page.locator("#announcement")).toContainText("rejected");
    await expect(page.locator("#config-preview")).toHaveValue(editedMixed);
    const rejected = await page.evaluate((policy) => {
      const session = (
        window as unknown as {
          __aihPolicyWorkbenchSession: {
            validatePolicy(value: unknown): unknown;
          };
        }
      ).__aihPolicyWorkbenchSession;
      try {
        session.validatePolicy(policy);
        return false;
      } catch {
        return true;
      }
    }, invalid);
    expect(rejected).toBe(true);
  }

  await expect(page.locator("#framework-rows > .error")).toHaveText("");
});

test("authors a protected decision through ordinary fields", async ({ page, workbench }) => {
  expect(workbench.networkRequests).toEqual([]);
  await page.locator('[data-view-tab="compose"]').click();
  await page.locator('[data-sanctioned-cli="codex"]').click();
  await page.locator("#posture").selectOption("enterprise");
  expect(JSON.parse(await page.locator("#config-preview").inputValue()).minimumPosture).toBe(
    "enterprise",
  );
  await page.locator('[data-view-tab="author"]').click();
  const fields: Record<string, string> = {
    "protected-bundle-version": "acme-policy-1",
    "protected-issuer-repository": "acme/aih-policy",
    "protected-issuer": "acme-security",
    "protected-issued-at": "2026-08-26T12:00:00Z",
    "protected-expires-at": "2026-09-25T12:00:00Z",
    "protected-decision-id": "decision-acme-linter-1",
    "protected-subject-id": "acme-linter",
    "protected-source-repository": "acme/linter",
    "protected-source-commit": "a".repeat(40),
    "protected-source-path": "packages/cli",
    "protected-targets": "codex",
    "protected-effects": "observe,use",
    "protected-evidence-id": "acme-scan-001",
    "protected-evidence-digest": `sha256:${"b".repeat(64)}`,
    "protected-attestor": "acme-scanner",
    "protected-policy-id": "enterprise-policy",
    "protected-policy-version": "1",
    "protected-policy-digest": `sha256:${"c".repeat(64)}`,
    "protected-control-id": "tool-admission",
    "protected-control-digest": `sha256:${"d".repeat(64)}`,
    "protected-actor": "ruchi.admin@acme.example",
    "protected-reason": "Approved after attributable scanner evidence review",
  };
  for (const [id, value] of Object.entries(fields)) await page.locator(`#${id}`).fill(value);
  await page.locator("#protected-form button[type=submit]").click();
  await expect(page.locator("#protected-bundle-preview")).not.toHaveValue("");
  const bundle = JSON.parse(await page.locator("#protected-bundle-preview").inputValue());
  expect(bundle.policy.minimumPosture).toBe("enterprise");
  expect(bundle.authorityReceipt.decisions).toHaveLength(1);
  expect(bundle.authorityReceipt.decisions[0]).toMatchObject({
    id: "decision-acme-linter-1",
    actor: "ruchi.admin@acme.example",
    subject: {
      kind: "tool",
      id: "acme-linter",
      source: {
        type: "github",
        repository: "acme/linter",
        commit: "a".repeat(40),
        path: "packages/cli",
      },
    },
    targets: ["codex"],
    allowedEffects: ["observe", "use"],
  });
  await expect(page.locator("#announcement")).toContainText("protected policy file is ready");
});
