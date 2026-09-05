import { readFile } from "node:fs/promises";
import { expect, test } from "./fixture.js";

test.use({ artifact: "packed-policy-workbench.html" });
test("installed package generates a complete offline artifact with usable export", async ({
  page,
  workbench,
}, testInfo) => {
  expect(workbench.networkRequests).toEqual([]);
  await expect(page.locator("article[data-workbench-asset-id]")).toHaveCount(0);
  await expect(page.locator("#preset-select, #skill-rows, #agent-rows, #mcp-rows")).toHaveCount(0);
  const shape = await page.evaluate(() => {
    const model = (window as unknown as { __aihWorkbenchModel: Record<string, unknown> })
      .__aihWorkbenchModel;
    const catalog = model.catalog as Record<string, unknown>;
    const bundle = model.workbenchBundle as {
      assets: Record<string, { sourceId: string; kind: string }>;
    };
    return {
      assetCount: Object.keys(bundle.assets).length,
      organizationKinds: Object.values(bundle.assets)
        .filter((asset) => asset.sourceId === "source:packed-organization")
        .map((asset) => asset.kind)
        .sort(),
      legacyArrays: ["assets", "mcp", "hookRegistry"].filter((key) => key in catalog),
    };
  });
  expect(shape.assetCount).toBeGreaterThan(100);
  expect(shape.legacyArrays).toEqual([]);
  expect(shape.organizationKinds).toEqual(["agent", "mcp", "skill"]);
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
});
