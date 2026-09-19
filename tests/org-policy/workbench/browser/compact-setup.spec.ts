import { pathToFileURL } from "node:url";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixture.js";

test.use({ artifact: "journeys-compact.html", viewport: { width: 1440, height: 900 } });

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`Expected visible layout element: ${locator}`);
  return box;
}

// NEW-SHELL-PLAN.md S3: sources-screen journeys moved to the new shell, assertions unchanged.
test.describe("new shell", () => {
  test("keeps the latest full item detail when switching through Exposure", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    const preview = page.locator("#config-preview");
    const before = await preview.inputValue();
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    await page.locator('[data-workbench-source-tab="source:ecc"]').click();
    const firstItem = page.locator("button.workbench-row-title[data-workbench-expand-id]").first();
    await expect(firstItem).toBeVisible();

    await firstItem.click();
    await page.locator('[data-workbench-source-tab="source:aih-core"]').click();
    const secondItem = page.locator("button.workbench-row-title[data-workbench-expand-id]").first();
    await expect(secondItem).toBeVisible();
    const secondAssetId = await secondItem.getAttribute("data-workbench-expand-id");
    if (secondAssetId === null) throw new Error("Expected a second catalog item to inspect");

    await secondItem.click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", secondAssetId);
    await inspector.locator(".workbench-item-technical > summary").click();
    await inspector.locator(`button[data-workbench-detail-id="${secondAssetId}"]`).click();
    await expect(inspector.locator(".workbench-detail-advanced")).toBeVisible();
    await expect(preview).toHaveValue(before);

    await inspector.locator('[data-workbench-panel-view="exposure"]').click();
    await expect(inspector.locator("[data-workbench-exposure-overview]")).toBeVisible();
    await inspector.locator('[data-workbench-panel-view="item"]').click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", secondAssetId);
    await expect(inspector.locator(".workbench-detail-advanced")).toBeVisible();
    await expect(preview).toHaveValue(before);
  });

  test("keeps policy exposure view-only while separating selections from pending requests", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    const preview = page.locator("#config-preview");
    const emptyPolicy = await preview.inputValue();
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    const overview = inspector.locator("[data-workbench-exposure-overview]");
    const exposureButton = inspector.locator('[data-workbench-panel-view="exposure"]');
    const count = (kind: "selected" | "requests" | "unresolved" | "verified") =>
      overview.locator(`[data-workbench-exposure-count="${kind}"]`);

    await expect(overview).toBeHidden();
    await exposureButton.click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-view", "exposure");
    await expect(overview).toBeVisible();
    await expect(
      overview.getByRole("heading", { name: "A policy is a shape of exposure", exact: true }),
    ).toBeVisible();
    await expect(exposureButton).toHaveAttribute("aria-controls", "workbench-detail-panel");
    for (const kind of ["selected", "requests", "unresolved", "verified"] as const)
      await expect(count(kind)).toContainText("0");
    await expect(overview.locator("[data-workbench-exposure-item-id]")).toHaveCount(0);
    await expect(overview.locator("[data-workbench-exposure-request-id]")).toHaveCount(0);
    await expect(overview).toContainText("Access declared by your catalog choices");
    await expect(overview).toContainText("credential scope may be unspecified");
    await expect(preview).toHaveValue(emptyPolicy);

    await page.locator('[data-workbench-source-tab="source:ecc"]').click();
    const selectedAction = page.locator("button[data-workbench-row-action]").first();
    await expect(selectedAction).toBeVisible();
    const selectedAssetId = await selectedAction.getAttribute("data-workbench-asset-id");
    if (selectedAssetId === null) throw new Error("Expected a compact ECC selection item");
    await selectedAction.click();
    const selectedPolicy = await preview.inputValue();
    expect(selectedPolicy).not.toBe(emptyPolicy);
    await exposureButton.click();
    await expect(count("selected")).toContainText("1");
    const selectedItem = overview.locator(`[data-workbench-exposure-item-id="${selectedAssetId}"]`);
    await expect(selectedItem).toBeVisible();
    await expect(selectedItem.locator("[data-workbench-exposure-access]")).toHaveText(
      /^Declared access: /u,
    );

    const request = await page.evaluate(() => {
      const model = window as unknown as {
        __aihWorkbenchModel: {
          workbenchBundle: {
            assets: Record<
              string,
              {
                id: string;
                sourceId: string;
                sourceRevisionId: string;
                contentDigest: string;
                authoring: { action: string };
              }
            >;
          };
        };
      };
      const asset = Object.values(model.__aihWorkbenchModel.workbenchBundle.assets).find(
        (candidate) =>
          candidate.id === "aih/github" && candidate.authoring.action === "record-request",
      );
      if (asset === undefined) throw new Error("Expected the retained GitHub pending-request item");
      return {
        assetId: asset.id,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
        origin: { kind: "administrator" },
      };
    });
    await page.locator(`[data-workbench-source-tab="${request.sourceId}"]`).click();
    await expect(page.locator(`article[data-workbench-asset-id="${request.assetId}"]`)).toHaveCount(
      0,
    );
    const importedPolicy = JSON.parse(selectedPolicy);
    importedPolicy.authoringSelections.requests = [request];
    await page.locator("#policy-file").setInputFiles({
      name: "saved-github-request.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importedPolicy)),
    });
    await expect
      .poll(async () => JSON.parse(await preview.inputValue()).authoringSelections.requests)
      .toEqual([request]);
    const policyWithRequest = await preview.inputValue();
    expect(policyWithRequest).not.toBe(selectedPolicy);
    await expect(
      page.getByText("Choices in draft", { exact: true }).locator("..").locator("strong"),
    ).toHaveText("1");
    await exposureButton.click();
    await expect(count("selected")).toContainText("1");
    await expect(count("requests")).toContainText("1");
    const pendingRequest = overview.locator(
      `[data-workbench-exposure-request-id="${request.assetId}"]`,
    );
    await expect(pendingRequest).toBeVisible();
    await expect(pendingRequest.locator("[data-workbench-exposure-access]")).toHaveText(
      /^Declared access: /u,
    );

    await selectedItem.locator(`[data-workbench-exposure-inspect-id="${selectedAssetId}"]`).click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", selectedAssetId);
    await expect(inspector.locator("[data-workbench-declaration]")).toBeVisible();
    await expect(inspector.locator("[data-workbench-checks]")).toBeVisible();
    await expect(preview).toHaveValue(policyWithRequest);
    await inspector.getByRole("button", { name: "Close details", exact: true }).click();
    await expect(overview).toBeHidden();
    await expect(preview).toHaveValue(policyWithRequest);

    await page.locator('[data-workbench-source-tab="source:ecc"]').click();
    const removal = page.locator(
      `button[data-workbench-row-action][data-workbench-asset-id="${selectedAssetId}"]`,
    );
    await expect(removal).toHaveAccessibleName(/^Remove my choice for /u);
    await removal.click();
    expect(await preview.inputValue()).not.toBe(policyWithRequest);
    await exposureButton.click();
    await expect(count("selected")).toContainText("0");
    await expect(overview.locator("[data-workbench-exposure-item-id]")).toHaveCount(0);
    await expect(count("requests")).toContainText("1");
    await expect(pendingRequest).toBeVisible();
    await page.locator('[data-workbench-panel-view="draft"]').click();
    const removeSaved = page.getByRole("button", {
      name: "Remove saved catalog request for Github",
      exact: true,
    });
    await expect(removeSaved).toBeVisible();
    await removeSaved.click();
    expect(JSON.parse(await preview.inputValue()).authoringSelections.requests).toEqual([]);

    const staleRequest = { ...request, contentDigest: `sha256:${"0".repeat(64)}` };
    const stalePolicy = JSON.parse(await preview.inputValue());
    stalePolicy.authoringSelections.requests = [staleRequest];
    await page.locator("#policy-file").setInputFiles({
      name: "stale-github-request.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(stalePolicy)),
    });
    await expect
      .poll(async () => JSON.parse(await preview.inputValue()).authoringSelections.requests)
      .toEqual([staleRequest]);
    await page.locator('[data-workbench-source-tab="source:aih-core"]').click();
    await expect(
      page.getByText("Choices in draft", { exact: true }).locator("..").locator("strong"),
    ).toHaveText("0");
  });

  // NEW-SHELL-PLAN.md S4: inspector-rail journeys moved to the new shell, assertions unchanged.
  test("keeps Back to catalog available in an empty mobile Item drawer", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await page.setViewportSize({ width: 375, height: 900 });
    const preview = page.locator("#config-preview");
    const before = await preview.inputValue();
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    const draftOpen = page.locator(".workbench-draft-review > button[data-workbench-draft-open]");
    await draftOpen.click();
    await expect(inspector).toBeVisible();
    await inspector.locator('[data-workbench-panel-view="item"]').click();
    const back = inspector.getByRole("button", { name: "Back to catalog", exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(inspector).toBeHidden();
    await expect(draftOpen).toBeFocused();
    await expect(preview).toHaveValue(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });

  test("closes the mobile inspector with focus restoration without mutating policy", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await page.setViewportSize({ width: 375, height: 900 });
    const preview = page.locator("#config-preview");
    const before = await preview.inputValue();
    await page.getByRole("combobox", { name: "Choose catalog source" }).selectOption("source:ecc");
    const inspect = page.locator("button.workbench-row-title[data-workbench-expand-id]").first();
    await expect(inspect).toBeVisible();
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    await inspect.focus();
    await page.keyboard.press("Enter");
    await expect(inspector).toBeVisible();
    await expect(inspector.locator("#workbench-detail-title")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
    await page.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    await expect(inspect).toBeFocused();
    await expect(inspect).toHaveAttribute("aria-expanded", "false");
    await expect(preview).toHaveValue(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });
});

/**
 * NEW-SHELL-PLAN.md S6: the organization-screen journeys moved to the new
 * shell. Behavioural assertions are unchanged; screen navigation is added
 * where a control now lives on another screen. Layout geometry the legacy
 * page measured against its toolbar (`.bar`) and the "Build your policy"
 * heading (both COSMETIC in id-contract.md) is measured against the new
 * shell's main panel `#wb-main`, the organization screen title and the
 * section after deployment setup; the legacy tab loop visits every new-shell
 * screen (ledger rows S6).
 */
test.describe("new shell organization screen", () => {
  async function openScreen(page: import("@playwright/test").Page, name: string) {
    const nav = page.getByRole("navigation", { name: "Workbench screens" });
    const collapsed = !(await nav.isVisible());
    if (collapsed) await page.locator("#toggle-nav-btn").click();
    await nav.getByRole("button", { name, exact: true }).click();
    if (collapsed) await page.locator("#toggle-nav-btn").click();
  }

  test("keeps the catalog anchored while panel navigation and inspection preserve policy", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    const preview = page.locator("#config-preview");
    const before = await preview.inputValue();
    const main = page.locator("#wb-main");
    const layout = page.locator("[data-workbench-catalog-layout]");
    const frameworkRows = page.locator("#framework-rows");
    const sourceRail = page.locator("[data-workbench-source-rail]");
    const register = page.locator("[data-workbench-catalog-register]");
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    const panelView = (view: "item" | "draft" | "exposure") =>
      inspector.locator(`[data-workbench-panel-view="${view}"]`);
    const overview = inspector.locator("[data-workbench-exposure-overview]");

    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(layout).toBeVisible();
      await expect(sourceRail).toBeVisible();
      await expect(register).toBeVisible();
      await expect(inspector).toBeVisible();
      const [mainBox, layoutBox, frameworkRowsBox, railBox, registerBox, inspectorBox] =
        await Promise.all([
          bounds(main),
          bounds(layout),
          bounds(frameworkRows),
          bounds(sourceRail),
          bounds(register),
          bounds(inspector),
        ]);
      expect(layoutBox.width).toBeGreaterThanOrEqual(mainBox.width - 48);
      expect(frameworkRowsBox.width).toBeGreaterThanOrEqual(mainBox.width - 48);
      expect(railBox.width).toBeGreaterThanOrEqual(width >= 1700 ? 195 : 180);
      expect(registerBox.width).toBeGreaterThanOrEqual(480);
      expect(inspectorBox.width).toBeGreaterThanOrEqual(width >= 1700 ? 360 : 320);
      // The source list is the nav rail's "Catalog scopes" section
      // (admin-sources.html), left of the main panel that holds the register.
      await expect(page.locator("#nav-rail [data-workbench-source-rail]")).toHaveCount(1);
      expect(railBox.x + railBox.width).toBeLessThanOrEqual(mainBox.x + 1);
      expect(registerBox.x).toBeGreaterThanOrEqual(layoutBox.x - 1);
      expect(registerBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
      expect(inspectorBox.x).toBeGreaterThanOrEqual(registerBox.x + registerBox.width - 1);
      expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }

    const readiness = page.locator("#deployment-readiness");
    await expect(readiness).not.toContainText("Enterprise posture");
    await page.locator("#validate").click();
    await expect(page.locator("#announcement")).toContainText(
      "Schema and policy-grammar validation passed.",
    );
    await expect(page.locator("#announcement")).not.toContainText("needs attention");
    const vibeDownload = page.waitForEvent("download");
    await page.locator("#download").click();
    expect((await vibeDownload).suggestedFilename()).toMatch(/\.json$/u);
    await expect(page.locator("#announcement")).toContainText("Policy download started.");

    await page.locator('[data-workbench-source-tab="source:ecc"]').click();
    const selectionAction = page.locator("button[data-workbench-row-action]").first();
    await expect(selectionAction).toBeVisible();
    const assetId = await selectionAction.getAttribute("data-workbench-asset-id");
    if (assetId === null) throw new Error("Expected an ECC catalog item to inspect");
    const itemTitle = page.locator(
      `button.workbench-row-title[data-workbench-expand-id="${assetId}"]`,
    );
    await expect(itemTitle).toBeVisible();
    const catalogTop = (await bounds(register)).y;
    await selectionAction.click();
    const selectedPolicy = await preview.inputValue();
    expect(selectedPolicy).not.toBe(before);

    const draftOpen = page.locator(".workbench-draft-review > button[data-workbench-draft-open]");
    await expect(draftOpen).toBeVisible();
    await draftOpen.click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-view", "draft");
    await expect(inspector.locator(".workbench-draft-review-list")).toBeVisible();
    expect(Math.abs((await bounds(register)).y - catalogTop)).toBeLessThanOrEqual(1);
    await expect(preview).toHaveValue(selectedPolicy);

    await panelView("item").click();
    await expect(inspector.locator(".workbench-draft-review-list")).toBeHidden();
    await expect(overview).toBeHidden();
    await expect(preview).toHaveValue(selectedPolicy);

    await panelView("exposure").click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-view", "exposure");
    await expect(overview).toBeVisible();
    await expect(
      overview.getByRole("heading", { name: "A policy is a shape of exposure", exact: true }),
    ).toBeVisible();
    await expect(preview).toHaveValue(selectedPolicy);

    await panelView("draft").click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-view", "draft");
    await expect(inspector.locator(".workbench-draft-review-list")).toBeVisible();
    await expect(preview).toHaveValue(selectedPolicy);

    await itemTitle.click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-asset-id", assetId);
    await expect(inspector.locator("#workbench-detail-title")).toBeVisible();
    await expect(preview).toHaveValue(selectedPolicy);
    const technicalDetails = inspector.locator(".workbench-item-technical");
    const technicalSummary = inspector.locator(".workbench-item-technical > summary");
    await expect(technicalDetails).not.toHaveAttribute("open", "");
    await expect(technicalSummary).toHaveText("More technical details");
    const selection = technicalDetails.locator(".workbench-inspector-selection");
    await expect(selection).toBeHidden();
    await technicalSummary.click();
    await expect(selection).toBeVisible();
    await expect(selection).toContainText("Draft status");
    await expect(preview).toHaveValue(selectedPolicy);

    await inspector.getByRole("button", { name: "Close details", exact: true }).click();
    await expect(inspector).toHaveAttribute("data-workbench-inspector-open", "false");
    await expect(inspector).toBeVisible();
    await expect(itemTitle).toBeFocused();
    await expect(preview).toHaveValue(selectedPolicy);
  });

  test("unifies references and collapsed developer tools inside deployment", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await openScreen(page, "Organization");
    await expect(page.locator(".reference-shelf")).toHaveCount(0);
    const setup = page.locator("#policy-settings");
    const developerTools = setup.locator("details#developer-tool-selection");
    const screenTitle = page.locator("#wb-screen-title-org");
    const main = page.locator("#wb-main");
    const policy = page.locator("#surface-ecc-hooks");
    await expect(page.locator("[data-developer-tool-id]")).toHaveCount(7);
    await expect(developerTools).not.toHaveAttribute("open", "");
    await expect(developerTools.locator("summary")).toContainText(/all default tools selected/i);
    await expect(page.locator("#developer-tool-rows")).toBeHidden();
    const titleBox = await bounds(screenTitle);
    const mainBox = await bounds(main);
    const setupBox = await bounds(setup);
    const toolsBox = await bounds(developerTools);
    const policyBox = await bounds(policy);
    expect(setupBox.height).toBeLessThan(180);
    expect(toolsBox.height).toBeLessThan(42);
    expect(setupBox.y - titleBox.y - titleBox.height).toBeLessThanOrEqual(24);
    expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual(setupBox.y + setupBox.height);
    expect(policyBox.y).toBeGreaterThanOrEqual(setupBox.y + setupBox.height);
    expect(policyBox.y - mainBox.y).toBeLessThan(300);

    const before = await page.locator("#config-preview").inputValue();
    const evidence = setup.locator("#evidence-delivery");
    await expect(setup.locator("#adoption-recipe-toggle")).toBeVisible();
    const adoptionChip = await bounds(setup.locator("#adoption-recipe-toggle"));
    const evidenceChip = await bounds(evidence.locator("summary"));
    expect(adoptionChip.width).toBeLessThan(220);
    expect(evidenceChip.x - (adoptionChip.x + adoptionChip.width)).toBeLessThan(12);
    await expect(evidence.locator("summary")).toHaveText("Evidence & versions");
    await evidence.locator("summary").click();
    await expect(evidence).toHaveAttribute("open", "");
    await expect(evidence).toContainText("A scan does not grant organization approval.");
    expect((await bounds(policy)).y).toBeCloseTo(policyBox.y, 0);
    await page.getByRole("button", { name: "Close evidence and versions", exact: true }).click();
    await expect(evidence).not.toHaveAttribute("open", "");
    await expect(evidence.locator("summary")).toBeFocused();
    await evidence.locator("summary").click();
    await page.keyboard.press("Escape");
    await expect(evidence).not.toHaveAttribute("open", "");
    await page.locator("#adoption-recipe-toggle").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#adoption-recipe-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Close adoption recipe" })).toBeFocused();
    expect((await bounds(policy)).y).toBeCloseTo(policyBox.y, 0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#adoption-recipe-toggle")).toBeFocused();
    await developerTools.locator("summary").focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#developer-tool-rows")).toBeVisible();
    await expect(developerTools).toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(developerTools).not.toHaveAttribute("open", "");
    await expect(page.locator("#developer-tool-rows")).toBeHidden();
    await expect(page.locator("#config-preview")).toHaveValue(before);
  });

  test("opens setup explanations by pointer and keyboard without editing policy", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await openScreen(page, "Organization");
    await page.locator("#developer-tool-selection > summary").click();
    const before = await page.locator("#config-preview").inputValue();
    const explanation = page.locator("#deployment-setup-help");
    await expect(explanation).toHaveText(
      "Choose the hosts this policy may target before adding Core controls. These choices record policy intent; they do not install, start, or contact a server.",
    );
    await expect(page.locator("#developer-tool-help")).toHaveText(
      "Choose the default developer tools for later setup. This authoring view records selection intent only; it does not claim a tool is installed, configured, or verified.",
    );
    for (const [buttonId, panelId] of [
      ["deployment-setup-info", "deployment-setup-help"],
      ["supported-cli-info", "supported-cli-note"],
      ["developer-tool-info", "developer-tool-help"],
      ["managed-mcp-info", "managed-mcp-help"],
    ]) {
      const button = page.locator(`#${buttonId}`);
      const panel = page.locator(`#${panelId}`);
      await button.hover();
      await expect(panel).toBeVisible();
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toBeVisible();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("heading", { name: "Organization", exact: true }).click();
      await expect(panel).toBeHidden();
      await button.click();
      await expect(panel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(button).toBeFocused();
    }
    await expect(page.locator("#supported-cli-note")).toContainText(
      "Sanctioned, materialization-capable, and projector-capable are separate sets.",
    );
    await expect(page.locator("#config-preview")).toHaveValue(before);
  });

  test("keeps compact controls usable and preserves MarkItDown CLI opt-out", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await openScreen(page, "Organization");
    const developerTools = page.locator("#developer-tool-selection");
    await developerTools.locator("summary").click();
    const row = page.locator('[data-developer-tool-id="markitdown"]');
    await expect(row).toContainText("MarkItDown CLI");
    await expect(row).toContainText("Selected: pending setup");
    await expect(row).toContainText(
      "The MCP adapter is optional and is not enabled by this selection.",
    );
    await row
      .getByRole("button", { name: "Exclude MarkItDown CLI from setup", exact: true })
      .click();
    await expect(row).toContainText("Excluded by policy");
    await developerTools.locator("summary").click();
    await expect(developerTools.locator("summary")).toContainText("6 selected");
    await expect(developerTools.locator("summary")).toContainText("1 excluded");
    await expect(row).toBeHidden();
    expect(
      JSON.parse(await page.locator("#config-preview").inputValue()).developerTools,
    ).toMatchObject({
      excluded: ["markitdown"],
    });
    await developerTools.locator("summary").click();
    await row.getByRole("button", { name: "Include MarkItDown CLI in setup", exact: true }).click();
    await expect(row).toContainText("Selected: pending setup");

    await page.locator('[data-sanctioned-cli="claude"]').click();
    await expect(page.locator("#supported-cli-count")).toContainText("1 selected");
    await openScreen(page, "Sources & Catalogs");
    await page
      .getByRole("button", { name: "Add to draft for Sequential Thinking", exact: true })
      .click();
    await openScreen(page, "Organization");
    await expect(page.locator("#deployment-readiness")).toContainText(
      "enable managed MCP projection",
    );
    await expect(page.locator("#deployment-readiness")).not.toContainText("Enterprise posture");
    const toggle = page.locator("#managed-mcp-projection");
    await toggle.check();
    await expect(page.locator("#deployment-readiness")).toContainText("Draft is ready to export.");
    await expect(page.locator("#deployment-readiness")).toContainText(
      "Governance MCP and hook projection remains disabled in Vibe",
    );
    expect(JSON.parse(await page.locator("#config-preview").inputValue()).minimumPosture).toBe(
      "vibe",
    );
    await page.locator("#posture").selectOption("enterprise");
    await expect(page.locator("#deployment-readiness")).not.toContainText("disabled in Vibe");
    expect(
      JSON.parse(await page.locator("#config-preview").inputValue()).governance.supportedClis,
    ).toEqual(["claude"]);
    await toggle.check();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.locator("#announcement")).toContainText(
      "Remove those controls before disabling this setting.",
    );
    await openScreen(page, "Sources & Catalogs");
    await page
      .getByRole("button", { name: "Remove my choice for Sequential Thinking", exact: true })
      .click();
    await openScreen(page, "Organization");
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator("#deployment-readiness")).toBeVisible();

    for (const width of [768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect(page.locator("#posture")).toBeVisible();
      if (width === 768) {
        const copy = await bounds(row.locator(".developer-tool-copy"));
        const actions = await bounds(row.locator(".developer-tool-actions"));
        expect(actions.x).toBeGreaterThanOrEqual(copy.x + copy.width);
        expect(actions.y).toBeLessThan(copy.y + copy.height);
      }
      expect(
        await page
          .locator(".developer-tool-actions button")
          .evaluateAll((buttons) =>
            buttons.every((button) => button.scrollHeight <= button.clientHeight),
          ),
      ).toBe(true);
      await row
        .getByRole("button", { name: "Exclude MarkItDown CLI from setup", exact: true })
        .click();
      await expect(row).toContainText("Excluded by policy");
      await row
        .getByRole("button", { name: "Include MarkItDown CLI in setup", exact: true })
        .click();
      await expect(row).toContainText("Selected: pending setup");
      const evidence = page.locator("#evidence-delivery");
      await evidence.locator("summary").click();
      const close = page.getByRole("button", { name: "Close evidence and versions", exact: true });
      await expect(close).toBeInViewport();
      await close.click();
      await expect(evidence).not.toHaveAttribute("open", "");
      await page.locator("#supported-cli-info").click();
      const note = page.locator("#supported-cli-note");
      await expect(note).toBeInViewport();
      expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.keyboard.press("Escape");
    }
  });

  test("keeps every tab dense and within the viewport without changing policy", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    const before = await page.locator("#config-preview").inputValue();
    for (const width of [1920, 1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, screen] of [
        ["Sources & Catalogs", "sources"],
        ["Scan Review", "scan"],
        ["Policies & Publish", "changes"],
        ["Organization", "org"],
        ["Additions & Approvals", "acme"],
      ] as const) {
        await openScreen(page, name);
        await page.locator("#wb-main").evaluate((element) => element.scrollTo(0, 0));
        const main = await bounds(page.locator("#wb-main"));
        const panel = await bounds(page.locator(`[data-wb-screen-panel="${screen}"]`));
        expect(panel.y - main.y).toBeLessThanOrEqual(24);
        if (width >= 1440) expect(panel.width).toBeGreaterThanOrEqual(main.width - 48);
        if (screen === "sources" && width >= 1440)
          expect((await bounds(page.locator("#framework-rows"))).width).toBeGreaterThanOrEqual(
            main.width - 48,
          );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await expect(page.locator(".reference-shelf")).toHaveCount(0);
        await expect(page.locator("#config-preview")).toHaveValue(before);
      }
    }
  });
});
