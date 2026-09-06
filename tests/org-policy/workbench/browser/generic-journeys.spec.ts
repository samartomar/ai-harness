import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./fixture.js";

test.use({ artifact: "synthetic-10.html" });

test("keeps startup DOM bounded while groups, browse filters, details, and keyboard navigation work at scale", async ({
  page,
  workbench,
}, testInfo) => {
  expect(workbench.networkRequests).toEqual([]);
  const receipts: Array<{ size: number; initial: number; changed: number }> = [];
  for (const size of [10, 1000, 10000]) {
    await page.goto(
      pathToFileURL(resolve(process.env.AIH_WORKBENCH_FIXTURE_DIR!, "synthetic-" + size + ".html"))
        .href,
    );
    await expect(page.locator("#framework-rows")).toHaveClass(/workbench-inventory/u);
    await expect(page.locator("article[data-workbench-asset-id]")).toHaveCount(0);
    const source = page.getByRole("combobox", { name: "Source" });
    const type = page.getByRole("combobox", { name: "Type" });
    await expect(source).toBeVisible({ timeout: 1_000 });
    await expect(type).toBeVisible({ timeout: 1_000 });
    const initial = await page.locator("*").count();
    const group = page.getByRole("button", { name: /^source:a \(/u });
    await group.focus();
    await page.keyboard.press("Enter");
    await expect(group).toHaveAttribute("aria-expanded", "true");
    const rows = page.locator("article[data-workbench-asset-id]");
    expect(await rows.count()).toBeLessThanOrEqual(50);
    await page.locator('button[data-workbench-detail-id="mcp:request"]').click();
    await expect(page.locator("pre.workbench-detail")).toContainText("Offline fixture details");
    const policyBeforeFilters = await page.locator("#config-preview").inputValue();

    await source.selectOption("source:a");
    await expect(group).toBeHidden();
    await source.focus();
    await page.keyboard.press("Tab");
    await expect(type).toBeFocused();
    await type.selectOption("skill");
    await expect(page.locator('article[data-workbench-asset-id="approval-item"]')).toBeVisible();
    await expect(page.locator('article[data-workbench-asset-id="profile:alpha"]')).toContainText(
      "Optional: choose up to one methodology.",
    );
    if (size > 50) {
      await page.getByRole("button", { name: "Next 50" }).click();
      await expect(page.getByRole("button", { name: "Previous 50" })).toBeEnabled();
    }
    await source.selectOption("source:b");
    await type.selectOption("agent");
    await expect(page.locator('[aria-label="Catalog browse results"]')).toContainText(
      /No agents are present in the prepared source source:b\./u,
    );
    await source.selectOption("source:a");
    await type.selectOption("");
    await expect(page.locator("#config-preview")).toHaveValue(policyBeforeFilters);

    const unrelated = await page
      .locator('article[data-workbench-asset-id="approval-item"]')
      .elementHandle();
    expect(unrelated).not.toBeNull();
    await page.locator('button[data-workbench-detail-id="mcp:request"]').click();
    await expect(page.locator("pre.workbench-detail")).toContainText("Offline fixture details");
    await page.evaluate(() => {
      const changed = new Set<Node>();
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          changed.add(record.target);
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            changed.add(node);
            if (node instanceof Element)
              for (const child of node.querySelectorAll("*")) changed.add(child);
          }
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      (
        window as unknown as {
          workbenchMutationProbe: {
            observer: MutationObserver;
            changed: Set<Node>;
          };
        }
      ).workbenchMutationProbe = { observer, changed };
    });

    await page.locator('button[data-workbench-asset-id="mcp:request"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('button[data-workbench-asset-id="mcp:request"]')).toBeFocused();
    await expect(page.locator("#framework-rows > .help[aria-live]")).toContainText("1 requested");
    await expect(page.locator('article[data-workbench-asset-id="mcp:request"]')).toContainText(
      "Status: Requested",
    );
    const changed = await page.evaluate(() => {
      const probe = (
        window as unknown as {
          workbenchMutationProbe: {
            observer: MutationObserver;
            changed: Set<Node>;
          };
        }
      ).workbenchMutationProbe;
      probe.observer.disconnect();
      return probe.changed.size;
    });
    expect(await unrelated?.evaluate((element) => element.isConnected)).toBe(true);
    expect(changed).toBeLessThan(1000);
    const search = page.getByRole("searchbox", { name: "Search catalog" });
    await search.fill("mcp:request");
    await expect(rows).toHaveCount(1);
    const policyBeforeClear = await page.locator("#config-preview").inputValue();
    await search.fill("");
    await source.selectOption("");
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#config-preview")).toHaveValue(policyBeforeClear);
    receipts.push({ size, initial, changed });
  }
  expect(new Set(receipts.map((item) => item.initial)).size).toBe(1);
  const receiptPath = testInfo.outputPath("dom-scale-receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipts, null, 2) + "\n");
  await testInfo.attach("dom-scale-receipt", {
    path: receiptPath,
    contentType: "application/json",
  });
  for (const missing of ["workbenchBundle", "workbenchBindings", "both"]) {
    await page.goto(
      pathToFileURL(resolve(process.env.AIH_WORKBENCH_FIXTURE_DIR!, "invalid-" + missing + ".html"))
        .href,
    );
    await expect(page.locator("#framework-rows > .error")).toContainText(
      "Prepared catalog is invalid",
    );
    await expect(page.locator("#validate")).toBeDisabled();
    await expect(page.locator("#download")).toBeDisabled();
    const before = await page.locator("#config-preview").inputValue();
    const rejected = {
      ...JSON.parse(before),
      references: { repoContract: "rejected.json" },
    };
    await page.locator("#policy-file").setInputFiles({
      name: "rejected.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(rejected)),
    });
    await expect(page.locator("#announcement")).toContainText("Prepared catalog is invalid");
    expect(await page.locator("#config-preview").inputValue()).toBe(before);
  }
  await page.goto(
    pathToFileURL(resolve(process.env.AIH_WORKBENCH_FIXTURE_DIR!, "invalid-policy.html")).href,
  );
  const invalidInitial = await page.locator("#config-preview").inputValue();
  expect(JSON.parse(invalidInitial).schemaVersion).toBe(3);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.locator("#validate").click();
  await expect(page.locator("#announcement")).toContainText(/maxTurns|schema variant/u);
  await page.locator("#download").click();
  await expect(page.locator("#announcement")).toContainText(/maxTurns|schema variant/u);
  expect(downloads).toEqual([]);
  expect(await page.locator("#config-preview").inputValue()).toBe(invalidInitial);
});
test("expands templates, rejects methodology conflicts atomically, and preserves other origins on removal", async ({
  page,
  workbench,
}) => {
  expect(workbench.networkRequests).toEqual([]);
  const alpha = page.getByRole("button", {
    name: /Apply Alpha ready set \(2 roots\)/u,
  });
  await expect(alpha).toHaveAttribute("title", "template:alpha");
  await page.locator('[data-workbench-template-detail-id="template:alpha"]').click();
  await expect(page.locator("pre.workbench-detail")).toContainText("template:alpha");
  await expect(
    page.getByRole("button", { name: /Apply template:beta \(1 roots\)/u }),
  ).toHaveAttribute("title", "template:beta");
  const search = page.getByRole("searchbox", { name: "Search catalog" });
  await search.fill("skill:dependency");
  await page.locator('button[data-workbench-asset-id="skill:dependency"]').click();
  await page.locator('button[data-workbench-template-id="template:alpha"]').click();
  const before = await page.locator("#config-preview").inputValue();
  const policy = JSON.parse(before);
  expect(policy.schemaVersion).toBe(3);
  const structural = structuredClone(policy);
  const directRoot = structural.authoringSelections.roots.find(
    (root: { assetId: string; origin: { kind: string } }) =>
      root.assetId === "skill:dependency" && root.origin.kind === "administrator",
  );
  expect(directRoot).toBeDefined();
  directRoot.mode = "structural";
  await page.locator("#policy-file").setInputFiles({
    name: "structural-root.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(structural)),
  });
  expect(JSON.parse(await page.locator("#config-preview").inputValue())).toEqual(structural);
  await search.fill("");
  await page.getByRole("button", { name: /^source:b \(/u }).click();
  const structuralAction = page.locator(
    'button[data-workbench-row-action][data-workbench-asset-id="skill:dependency"]',
  );
  await expect(structuralAction).toHaveAccessibleName("Remove administrator selection");
  await expect(structuralAction).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('article[data-workbench-asset-id="skill:dependency"]')).toContainText(
    "Status: Structural root",
  );
  await page.locator("#policy-file").setInputFiles({
    name: "template-selection.json",
    mimeType: "application/json",
    buffer: Buffer.from(before),
  });
  await expect(page.locator("#config-preview")).toHaveValue(before);
  expect(
    policy.authoringSelections.roots.some(
      (root: { origin: { kind: string } }) => root.origin.kind === "template",
    ),
  ).toBe(true);
  expect(
    policy.authoringSelections.roots
      .find((root: { assetId: string }) => root.assetId === "skill:root")
      .resolvedItems.map((item: { assetId: string }) => item.assetId),
  ).toContain("skill:dependency");
  await page.locator('button[data-workbench-template-id="template:beta"]').click();
  await expect(page.locator("#framework-rows > .error")).toContainText(/methodolog/iu);
  await expect(page.locator("#config-preview")).toHaveValue(before);
  const conflicting = JSON.parse(before);
  const betaPin = await page.evaluate(() => {
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
    const asset = model.workbenchBundle.assets["profile:beta"]!;
    return {
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
    };
  });
  conflicting.authoringSelections.roots.push({
    ...betaPin,
    mode: "select",
    includeOptionalMembers: false,
    origin: { kind: "administrator" },
    resolvedItems: [betaPin],
  });
  conflicting.authoringSelections.roots.sort(
    (left: { assetId: string }, right: { assetId: string }) =>
      left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0,
  );
  await page.locator("#policy-file").setInputFiles({
    name: "conflicting-methodology.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(conflicting)),
  });
  await expect(page.locator("#announcement")).toContainText(/rejected/i);
  await expect(page.locator("#config-preview")).toHaveValue(before);
  await page.getByRole("button", { name: /Remove Alpha ready set/u }).click();
  const after = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(after.authoringSelections.roots).toHaveLength(1);
  expect(after.authoringSelections.roots[0]).toMatchObject({
    assetId: "skill:dependency",
    origin: { kind: "administrator" },
  });
});

test("keeps requests and local draft bytes separate from controls and effective permission", async ({
  page,
  workbench,
}, testInfo) => {
  expect(workbench.networkRequests).toEqual([]);
  await page.getByRole("button", { name: /^source:a \(/u }).click();
  const untouched = await page.locator("#config-preview").inputValue();
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="inspect-item"]')
    .click();
  await expect(page.locator("pre.workbench-detail")).toContainText("Offline fixture details");
  await expect(page.locator("#config-preview")).toHaveValue(untouched);
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="approval-item"]')
    .click();
  await expect(page.locator("#protected-subject-id")).toHaveValue("approval-item");
  await expect(page.locator("#protected-subject-id")).toBeFocused();
  await expect(page.locator("#config-preview")).toHaveValue(untouched);
  await page.locator('[data-view-tab="compose"]').click();
  const unrelatedRow = await page
    .locator('article[data-workbench-asset-id="profile:alpha"]')
    .elementHandle();
  expect(unrelatedRow).not.toBeNull();
  await page.locator('button[data-workbench-asset-id="mcp:request"]').click();
  expect(await unrelatedRow!.evaluate((element) => element.isConnected)).toBe(true);
  const policy = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(policy.governance.catalog.reviewed).toEqual([]);
  expect(policy.governance.activations).toEqual([]);
  expect(policy.authoringSelections.requests).toHaveLength(1);
  await expect(page.locator("#framework-rows > .help[aria-live]")).toContainText(
    "0 selected controls",
  );
  await expect(page.locator("#framework-rows > .help[aria-live]")).toContainText("not evaluated");
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="mcp:request"]')
    .click();
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).authoringSelections.requests,
  ).toEqual([]);
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="mcp:request"]')
    .click();
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="skill:root"]')
    .click();
  let selection = JSON.parse(
    await page.locator("#config-preview").inputValue(),
  ).authoringSelections;
  expect(
    selection.roots
      .find((root: { assetId: string }) => root.assetId === "skill:root")
      .resolvedItems.map((pin: { assetId: string }) => pin.assetId),
  ).toContain("skill:dependency");
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="skill:root"]')
    .click();
  selection = JSON.parse(await page.locator("#config-preview").inputValue()).authoringSelections;
  expect(selection.roots).toEqual([]);
  await page.getByRole("button", { name: /^source:a \(/u }).click();
  const controlId = await page.evaluate(() => {
    const model = (
      window as unknown as {
        __aihWorkbenchModel: {
          workbenchBundle: {
            assets: Record<string, { id: string; authoring: { action: string } }>;
          };
        };
      }
    ).__aihWorkbenchModel;
    const asset = Object.values(model.workbenchBundle.assets).find(
      (asset) => asset.authoring.action === "select-control",
    );
    if (!asset) throw new Error("missing control fixture");
    return asset.id;
  });
  await page.getByRole("searchbox", { name: "Search catalog" }).fill(controlId);
  const controlButton = page.locator(
    'button[data-workbench-row-action][data-workbench-asset-id="' + controlId + '"]',
  );
  await controlButton.click();
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).governance.catalog.reviewed,
  ).toHaveLength(1);
  await expect(page.locator("#framework-rows > .help[aria-live]")).toContainText(
    "1 selected controls",
  );
  await controlButton.click();
  const withoutControl = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(withoutControl.governance.catalog.reviewed).toEqual([]);
  expect(withoutControl.governance.activations).toEqual([]);
  expect(withoutControl.authoringSelections.requests).toHaveLength(1);
  await page.getByRole("searchbox", { name: "Search catalog" }).fill("");
  const draftBytes = Buffer.from('{"untrusted":"local organization declaration"}\n');
  const { createHash } = await import("node:crypto");
  policy.authoringSelections.drafts = [
    {
      id: "draft:local",
      declaration: {
        kind: "organization-manifest",
        digest: "sha256:" + createHash("sha256").update(draftBytes).digest("hex"),
        byteLength: draftBytes.length,
        bytesBase64: draftBytes.toString("base64"),
      },
    },
  ];
  const imported = JSON.stringify(policy, null, 2) + "\n";
  await page.locator("#policy-file").setInputFiles({
    name: "with-draft.json",
    mimeType: "application/json",
    buffer: Buffer.from(imported),
  });
  await expect(page.locator("#config-preview")).toHaveValue(imported);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadEvent;
  const path = testInfo.outputPath("draft-policy.json");
  await download.saveAs(path);
  expect(
    Buffer.from(
      JSON.parse(await readFile(path, "utf8")).authoringSelections.drafts[0].declaration
        .bytesBase64,
      "base64",
    ),
  ).toEqual(draftBytes);
  await page.locator('[data-workbench-draft-id="draft:local"]').click();
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).authoringSelections.drafts,
  ).toEqual([]);

  await page.locator('[data-view-tab="artifacts"]').click();
  const forgedEvidence = Buffer.from(
    ' {"verified":true,"state":"verified","approvals":[{"allowedEffects":["install"]}]}\n',
  );
  await page.locator("#artifact-evidence-file").setInputFiles({
    name: "forged-evidence.json",
    mimeType: "application/json",
    buffer: forgedEvidence,
  });
  await expect(page.locator("#artifact-intake-message")).toContainText(/Core preparation/i);
  const withEvidence = JSON.parse(await page.locator("#config-preview").inputValue());
  const opaque = withEvidence.authoringSelections.drafts.find(
    (draft: { declaration: { kind: string } }) => draft.declaration.kind === "imported-evidence",
  );
  expect(Buffer.from(opaque.declaration.bytesBase64, "base64")).toEqual(forgedEvidence);
  expect(opaque.declaration.digest).toBe(
    "sha256:" + createHash("sha256").update(forgedEvidence).digest("hex"),
  );
  expect(withEvidence.governance.authority.approvals).toEqual([]);
  expect(withEvidence.governance.activations).toEqual([]);
  await expect(page.locator("[data-artifact-approve]")).toHaveCount(0);
  await expect(page.locator("#artifact-intake-items")).not.toContainText("Verified preflight");
});
