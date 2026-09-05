import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./fixture.js";

test("opens offline and keeps exact prepared evidence separate from permission across expiry", async ({
  page,
  workbench,
}) => {
  expect(workbench.path).toContain("aih-policy-workbench.html");
  const policy = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(policy.references.repoContract).toBe("ai-coding/project.json");
  expect(policy.governance.aihMcpRequests).toBeUndefined();
  await expect(page.locator("#download")).toBeEnabled();
  await page.clock.setFixedTime(new Date("2026-09-04T12:30:00Z"));
  await page.goto(
    pathToFileURL(resolve(process.env.AIH_WORKBENCH_FIXTURE_DIR!, "synthetic-evidence.html")).href,
  );
  const search = page.getByRole("searchbox", { name: "Search catalog" });
  await search.fill("mcp:request");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "evidence: verified · pass/complete · unknown",
  );
  await expect(page.locator("#framework-rows > .help[aria-live]")).toContainText(
    "0 selected controls",
  );
  await search.fill("skill:root");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText(
    "evidence: verified · failed/complete · unknown",
  );
  await page.clock.setFixedTime(new Date("2026-09-04T13:00:00Z"));
  await search.fill("mcp:request");
  await expect(page.locator("article[data-workbench-asset-id]")).toContainText("evidence: stale");
  await expect(page.locator("article[data-workbench-asset-id]")).not.toContainText("pass/complete");
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
    { ...versioned, authoringSelections: { ...state, exclusions: [exclusion, exclusion] } },
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
    return ["source:ecc", "source:superpowers"].map((sourceId) => {
      const asset = Object.values(model.workbenchBundle.assets).find(
        (asset) =>
          asset.sourceId === sourceId &&
          asset.kind === "skill" &&
          !asset.exclusiveSlot &&
          asset.authoring.action === "record-selection",
      );
      if (!asset) throw new Error("missing compatible source fixture");
      return asset.id;
    });
  });
  for (const assetId of compatibleAssets) {
    await page.getByRole("searchbox", { name: "Search catalog" }).fill(assetId);
    await page
      .locator('button[data-workbench-row-action][data-workbench-asset-id="' + assetId + '"]')
      .click();
  }
  const mixedPolicy = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(
    mixedPolicy.authoringSelections.roots.map((root: { sourceId: string }) => root.sourceId).sort(),
  ).toEqual(["source:ecc", "source:superpowers"]);
  await page.locator('[data-view-tab="author"]').click();
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
  const withSecurity = { ...JSON.parse(editedMixed), security: { strix: validStrix } };
  await page.evaluate((policy) => {
    (
      window as unknown as {
        __aihPolicyWorkbenchSession: { validatePolicy(value: unknown): unknown };
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
          __aihPolicyWorkbenchSession: { validatePolicy(value: unknown): unknown };
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
  await page.locator('[data-view-tab="author"]').click();
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
