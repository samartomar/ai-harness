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
    // The automatic fixture has already opened the ten-asset artifact.
    if (size !== 10) {
      await page.goto(
        pathToFileURL(
          resolve(process.env.AIH_WORKBENCH_FIXTURE_DIR!, "synthetic-" + size + ".html"),
        ).href,
      );
    }
    await expect(page.locator("#framework-rows")).toHaveClass(/workbench-inventory/u);
    const rows = page.locator("article[data-workbench-asset-id]");
    const activeSourceCount = await page.evaluate(() => {
      const model = window as unknown as {
        __aihWorkbenchModel: {
          workbenchBundle: { assets: Record<string, { sourceId: string }> };
        };
      };
      return Object.values(model.__aihWorkbenchModel.workbenchBundle.assets).filter(
        (asset) => asset.sourceId === "source:a",
      ).length;
    });
    expect(await rows.count()).toBeLessThanOrEqual(50);
    await expect(page.locator(".workbench-draft-review-item")).toHaveCount(0);
    const source = page.getByRole("combobox", {
      name: "Choose catalog source",
    });
    await expect(source).toBeHidden({ timeout: 1_000 });
    const sourceATab = page.locator('[data-workbench-source-tab="source:a"]');

    const chooseSource = async (sourceId: string): Promise<void> => {
      const tab = page.locator(`[data-workbench-source-tab="${sourceId}"]`);
      await tab.click();
      await expect(tab).toBeFocused();
      await expect(tab).toHaveAttribute("aria-pressed", "true");
    };
    await expect(sourceATab).toBeVisible();
    await expect(page.locator(".workbench-source-review")).toContainText("Reports included");
    await expect(page.locator(".workbench-source-review")).toContainText("Needs review");
    await chooseSource("source:b");
    await chooseSource("source:a");
    await expect(rows).toHaveCount(Math.min(activeSourceCount, 50));
    if (size === 10) {
      await page.setViewportSize({ width: 375, height: 800 });
      await expect(source).toBeVisible();
      await source.selectOption("source:b");
      await expect(source).toBeFocused();
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(source).toBeHidden();
      await chooseSource("source:a");
    }
    const initial = await page.locator("*").count();
    expect(await rows.count()).toBeLessThanOrEqual(50);
    await page.locator('button[data-workbench-expand-id="mcp:request"]').click();
    await page.locator('button[data-workbench-detail-id="mcp:request"]').click();
    await expect(page.locator("[data-workbench-detail]")).toBeVisible();
    await expect(page.locator(".workbench-detail-advanced pre")).toBeHidden();
    await expect(page.locator(".workbench-detail-advanced summary")).toHaveAccessibleName(
      "Advanced prepared metadata",
    );
    await page.locator(".workbench-detail-advanced summary").click();
    await expect(page.locator(".workbench-detail-advanced pre")).toBeVisible();
    await expect(page.locator(".workbench-detail-advanced pre")).toContainText(
      "Offline fixture details",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-workbench-detail]")).toBeHidden();
    if (size === 10) {
      const detailButton = page.locator('button[data-workbench-detail-id="mcp:request"]');
      await expect(detailButton).toHaveAccessibleDescription("MCP Request");
      await detailButton.click();
      await chooseSource("source:b");
      await expect(page.locator("[data-workbench-detail]")).toBeHidden();
      await chooseSource("source:a");
    }
    const policyBeforeFilters = await page.locator("#config-preview").inputValue();

    await chooseSource("source:a");
    await expect(page.locator('[data-workbench-source-tab="source:a"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('article[data-workbench-asset-id="approval-item"]')).toBeVisible();
    await expect(page.locator('article[data-workbench-asset-id="profile:alpha"]')).toContainText(
      "Optional: choose up to one methodology.",
    );
    if (size > 50) {
      await chooseSource("source:b");
      const catalogPager = page.locator(
        '[aria-label="Catalog browse results"] .workbench-page-controls',
      );
      await expect(catalogPager).toContainText("Showing 1–50 of");
      expect(
        await catalogPager.evaluate((element) => {
          const rows = element.parentElement?.querySelector(".workbench-inventory-rows");
          return (
            rows !== null &&
            rows !== undefined &&
            Boolean(element.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING)
          );
        }),
      ).toBe(true);
      await page.getByRole("button", { name: "Next 50" }).click();
      await expect(page.getByRole("button", { name: "Previous 50" })).toBeEnabled();
      await expect(catalogPager).toContainText("Showing 51–");
      await chooseSource("source:a");
    }
    await chooseSource("source:b");
    await expect(page.locator('article[data-workbench-asset-id="approval-item"]')).toHaveCount(0);
    await chooseSource("source:a");
    await expect(page.locator("#config-preview")).toHaveValue(policyBeforeFilters);

    await page.locator('button[data-workbench-expand-id="mcp:request"]').click();
    await page.locator('button[data-workbench-detail-id="mcp:request"]').click();
    await expect(page.locator("[data-workbench-detail]")).toBeVisible();
    await expect(page.locator(".workbench-detail-advanced pre")).toBeHidden();
    await expect(page.locator(".workbench-detail-advanced summary")).toHaveAccessibleName(
      "Advanced prepared metadata",
    );
    await page.locator(".workbench-detail-advanced summary").click();
    await expect(page.locator(".workbench-detail-advanced pre")).toBeVisible();
    await expect(page.locator(".workbench-detail-advanced pre")).toContainText(
      "Offline fixture details",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-workbench-detail]")).toBeHidden();
    const unrelated = await page
      .locator('article[data-workbench-asset-id="approval-item"]')
      .elementHandle();
    expect(unrelated).not.toBeNull();
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
    await expect(page.locator(".workbench-draft-counts")).toContainText("Requests 1");
    await expect(page.locator('article[data-workbench-asset-id="mcp:request"]')).toContainText(
      "Status: Pending request",
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
    const sourceDraftCount = page.locator(".workbench-source-review-cells p").nth(2);
    await expect(sourceDraftCount).toContainText("1");
    await page.locator('button[data-workbench-asset-id="mcp:request"]').click();
    await expect(sourceDraftCount).toContainText("0");
    const search = page.getByRole("searchbox", { name: "Search catalog" });
    await search.fill("mcp:request");
    await expect(rows).toHaveCount(1);
    const policyBeforeClear = await page.locator("#config-preview").inputValue();
    await search.fill("");
    await chooseSource("source:a");
    await expect(page.locator('[data-workbench-source-tab="source:a"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#config-preview")).toHaveValue(policyBeforeClear);
    receipts.push({ size, initial, changed });
  }
  expect(new Set(receipts.slice(1).map((item) => item.initial)).size).toBe(1);
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
  await page.locator('[data-workbench-source-tab="source:a"]').click();
  await page.locator(".workbench-starting-points > summary").click();
  const unchanged = await page.locator("#config-preview").inputValue();
  await page.locator('[data-workbench-template-detail-id="template:alpha"]').click();
  await expect(page.locator("[data-workbench-detail]")).toContainText("Alpha ready set");
  await expect(page.locator(".workbench-template-preview")).toContainText("This preview adds");
  await expect(page.locator(".workbench-detail-advanced pre")).toBeHidden();
  await expect(page.locator("#config-preview")).toHaveValue(unchanged);
  await page.getByRole("button", { name: "Cancel preview", exact: true }).click();
  await expect(page.locator("#config-preview")).toHaveValue(unchanged);
  await page.locator('[data-workbench-template-detail-id="template:alpha"]').click();
  await page.locator("#policy-file").setInputFiles({
    name: "restore-draft.json",
    mimeType: "application/json",
    buffer: Buffer.from(unchanged),
  });
  await expect(page.locator("[data-workbench-detail]")).toBeHidden();
  await expect(page.locator("#config-preview")).toHaveValue(unchanged);
  const search = page.getByRole("searchbox", { name: "Search catalog" });
  await page.locator('[data-workbench-source-tab="source:b"]').click();
  await search.fill("skill:dependency");
  await page.locator('button[data-workbench-asset-id="skill:dependency"]').click();
  await page.locator('[data-workbench-source-tab="source:a"]').click();
  await page.locator(".workbench-starting-points > summary").click();
  await page.locator('[data-workbench-template-detail-id="template:alpha"]').click();
  await page.locator('button[data-workbench-template-id="template:alpha"]').click();
  await search.fill("skill:root");
  await expect(page.locator('article[data-workbench-asset-id="skill:root"]')).toContainText(
    "Status: In your draft",
  );
  await expect(page.locator('article[data-workbench-asset-id="skill:root"]')).toContainText(
    "Direct origin: Template template:alpha",
  );
  await page.locator('[data-workbench-source-tab="source:b"]').click();
  await search.fill("scale:000008");
  const excludedRow = page.locator('article[data-workbench-asset-id="scale:000008"]');
  await expect(excludedRow).toContainText("Exclusion origin: Template template:alpha");
  await excludedRow.locator('button[data-workbench-expand-id="scale:000008"]').click();
  await excludedRow.getByText("More options", { exact: true }).click();
  await excludedRow
    .getByRole("button", {
      name: "Exclude from optional groups for Scale 000008",
      exact: true,
    })
    .click();
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).authoringSelections.exclusions,
  ).toHaveLength(2);
  await excludedRow
    .getByRole("button", {
      name: "Undo my exclusion for Scale 000008",
      exact: true,
    })
    .click();
  await expect(excludedRow).toContainText("Status: Excluded by a saved origin");
  await expect(excludedRow).toContainText("Exclusion origin: Template template:alpha");
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).authoringSelections.exclusions,
  ).toHaveLength(1);
  await search.fill("skill:dependency");
  const before = await page.locator("#config-preview").inputValue();
  const policy = JSON.parse(before);
  expect(policy.schemaVersion).toBe(3);
  const retiredTemplateDigest = "sha256:" + "f".repeat(64);
  const changedTemplateOrigin = structuredClone(policy);
  for (const entries of [
    changedTemplateOrigin.authoringSelections.roots,
    changedTemplateOrigin.authoringSelections.requests,
    changedTemplateOrigin.authoringSelections.exclusions,
  ]) {
    for (const entry of entries) {
      if (entry.origin?.kind === "template") entry.origin.digest = retiredTemplateDigest;
    }
  }
  await page.locator("#policy-file").setInputFiles({
    name: "changed-template-origin.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(changedTemplateOrigin)),
  });
  await page.locator('[data-workbench-source-tab="source:a"]').click();
  await page.locator(".workbench-starting-points > summary").click();
  await expect(
    page.locator(
      `[data-workbench-template-remove-id="template:alpha"][data-workbench-template-remove-digest="${retiredTemplateDigest}"]`,
    ),
  ).toHaveCount(0);
  await page.locator(".workbench-draft-review > summary").click();
  const changedTemplateRemoval = page
    .locator(
      `[data-workbench-template-remove-id="template:alpha"][data-workbench-template-remove-digest="${retiredTemplateDigest}"]`,
    )
    .first();
  await expect(changedTemplateRemoval).toBeVisible();
  await changedTemplateRemoval.click();
  const changedTemplateRemoved = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(changedTemplateRemoved.authoringSelections.roots).toEqual([
    expect.objectContaining({ assetId: "skill:dependency", origin: { kind: "administrator" } }),
  ]);
  expect(changedTemplateRemoved.authoringSelections.exclusions).toEqual([]);
  await page.locator("#policy-file").setInputFiles({
    name: "restore-current-template-origin.json",
    mimeType: "application/json",
    buffer: Buffer.from(before),
  });
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
  await expect
    .poll(async () => JSON.parse(await page.locator("#config-preview").inputValue()))
    .toEqual(structural);
  await search.fill("");
  await page.locator('[data-workbench-source-tab="source:b"]').click();
  const structuralAction = page.locator(
    'button[data-workbench-row-action][data-workbench-asset-id="skill:dependency"]',
  );
  await expect(structuralAction).toHaveAccessibleName("Remove my choice for Skill Dependency");
  await expect(structuralAction).not.toHaveAttribute("aria-pressed");
  await expect(page.locator('article[data-workbench-asset-id="skill:dependency"]')).toContainText(
    "Status: Included as a group",
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
  await page.locator('[data-workbench-source-tab="source:b"]').click();
  await page.locator(".workbench-starting-points > summary").click();
  await page.locator('[data-workbench-template-detail-id="template:beta"]').click();
  await expect(page.locator(".workbench-template-preview")).toContainText(/methodolog/iu);
  await expect(page.locator('button[data-workbench-template-id="template:beta"]')).toHaveCount(0);
  await expect(page.locator("#config-preview")).toHaveValue(before);
  await page.getByRole("button", { name: "Cancel preview", exact: true }).click();
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
  await page.locator('[data-workbench-source-tab="source:a"]').click();
  await page.locator(".workbench-starting-points > summary").click();
  await page.getByRole("button", { name: /Remove starting point Alpha ready set/u }).click();
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
  await page.locator('[data-workbench-source-tab="source:a"]').click();
  const untouched = await page.locator("#config-preview").inputValue();
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="inspect-item"]')
    .click();
  await expect(page.locator("[data-workbench-detail]")).toBeVisible();
  await expect(page.locator(".workbench-detail-advanced pre")).toBeHidden();
  await page.locator(".workbench-detail-advanced summary").click();
  await expect(page.locator(".workbench-detail-advanced pre")).toBeVisible();
  await expect(page.locator(".workbench-detail-advanced pre")).toContainText(
    "Offline fixture details",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-workbench-detail]")).toBeHidden();
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
  await expect(page.locator(".workbench-draft-counts")).toContainText("Controls 0");
  await expect(page.locator("body")).toContainText("not evaluated");
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
  await page.locator(".workbench-draft-review > summary").click();
  const review = page.locator(".workbench-draft-review-list");
  await expect(review).toContainText("Skill Root");
  await expect(review).toContainText("Skill Dependency");
  await expect(review).toContainText("Request");
  await expect(review).toContainText("MCP Request");
  await expect(review.locator(".workbench-draft-review-item")).toHaveCount(3);
  const reason = "Use the local review skill for this project; keep external tools separate.";
  const rootReview = review
    .locator(".workbench-draft-review-item")
    .filter({ has: page.getByRole("heading", { name: "Skill Root", exact: true }) });
  await rootReview.getByRole("textbox").fill(reason);
  await rootReview.getByRole("button", { name: "Save reason", exact: true }).click();
  await expect(rootReview.getByRole("status")).toContainText("Reason saved");
  const withReason = JSON.parse(
    await page.locator("#config-preview").inputValue(),
  ).authoringSelections;
  expect(
    withReason.roots.find((root: { assetId: string }) => root.assetId === "skill:root").rationale,
  ).toBe(reason);
  expect(
    withReason.roots.find((root: { assetId: string }) => root.assetId === "skill:root")
      .resolvedItems,
  ).toEqual(
    selection.roots.find((root: { assetId: string }) => root.assetId === "skill:root")
      .resolvedItems,
  );
  await page.locator(".workbench-draft-review > summary").click();
  await expect(review.locator(".workbench-draft-review-item")).toHaveCount(0);
  await page
    .locator('button[data-workbench-row-action][data-workbench-asset-id="skill:root"]')
    .click();
  selection = JSON.parse(await page.locator("#config-preview").inputValue()).authoringSelections;
  expect(selection.roots).toEqual([]);
  const control = await page.evaluate(() => {
    const model = (
      window as unknown as {
        __aihWorkbenchModel: {
          workbenchBundle: {
            assets: Record<string, { id: string; sourceId: string; authoring: { action: string } }>;
          };
        };
      }
    ).__aihWorkbenchModel;
    const asset = Object.values(model.workbenchBundle.assets).find(
      (asset) => asset.authoring.action === "select-control",
    );
    if (!asset) throw new Error("missing control fixture");
    return { id: asset.id, sourceId: asset.sourceId };
  });
  await page.locator(`[data-workbench-source-tab="${control.sourceId}"]`).click();
  await page.getByRole("searchbox", { name: "Search catalog" }).fill(control.id);
  const controlButton = page.locator(
    'button[data-workbench-row-action][data-workbench-asset-id="' + control.id + '"]',
  );
  await controlButton.click();
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).governance.catalog.reviewed,
  ).toHaveLength(1);
  await expect(page.locator(".workbench-draft-counts")).toContainText("Controls 1");
  await controlButton.click();
  const withoutControl = JSON.parse(await page.locator("#config-preview").inputValue());
  expect(withoutControl.governance.catalog.reviewed).toEqual([]);
  expect(withoutControl.governance.activations).toEqual([]);
  expect(withoutControl.authoringSelections.requests).toHaveLength(1);
  const unsupportedPolicy =
    JSON.stringify(
      {
        ...withoutControl,
        governance: { ...withoutControl.governance, supportedClis: ["opencode"] },
      },
      null,
      2,
    ) + "\n";
  await page.locator("#policy-file").setInputFiles({
    name: "unsupported-control-host.json",
    mimeType: "application/json",
    buffer: Buffer.from(unsupportedPolicy),
  });
  await expect(page.locator("#config-preview")).toHaveValue(unsupportedPolicy);
  await controlButton.click();
  await expect(
    page.getByText(
      "fixture:control cannot be added for the selected hosts (opencode). Supported hosts: claude, codex. Review Deployment setup or leave this item out.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator("#config-preview")).toHaveValue(unsupportedPolicy);
  await expect(page.locator(".workbench-draft-counts")).toContainText("Controls 0");
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
  await page.locator(".workbench-drafts > summary").click();
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
