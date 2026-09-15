import { pathToFileURL } from "node:url";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixture.js";

test.use({ artifact: "journeys-compact.html", viewport: { width: 1440, height: 900 } });

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`Expected visible layout element: ${locator}`);
  return box;
}

test("keeps reference material outside the compact setup workflow", async ({ page, workbench }) => {
  await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
  const shelf = page.locator(".reference-shelf");
  const setup = page.locator("#policy-settings");
  const developerTools = page.locator("#developer-tool-selection");
  const policy = page.getByRole("heading", { name: "Build your policy", exact: true });
  await expect(page.locator("[data-developer-tool-id]")).toHaveCount(6);
  const shelfBox = await bounds(shelf);
  const setupBox = await bounds(setup);
  const toolsBox = await bounds(developerTools);
  const policyBox = await bounds(policy);
  expect(shelfBox.height).toBeCloseTo(34, 0);
  expect(setupBox.height).toBeLessThan(160);
  expect(toolsBox.height).toBeLessThan(400);
  expect(setupBox.y).toBeGreaterThanOrEqual(shelfBox.y + shelfBox.height);
  expect(toolsBox.y).toBeGreaterThanOrEqual(setupBox.y + setupBox.height);
  expect(policyBox.y).toBeGreaterThanOrEqual(toolsBox.y + toolsBox.height);
  expect(policyBox.y).toBeLessThan(800);

  const before = await page.locator("#config-preview").inputValue();
  const evidence = page.locator("#evidence-delivery");
  await expect(shelf.locator("#adoption-recipe-toggle")).toBeVisible();
  const adoptionChip = await bounds(shelf.locator("#adoption-recipe-toggle"));
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
  await expect(page.locator("#config-preview")).toHaveValue(before);
});

test("opens setup explanations by pointer and keyboard without editing policy", async ({
  page,
  workbench,
}) => {
  await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
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
    await page.getByRole("heading", { name: "Build your policy", exact: true }).click();
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
  const row = page.locator('[data-developer-tool-id="markitdown"]');
  await expect(row).toContainText("MarkItDown CLI");
  await expect(row).toContainText("Selected — pending setup");
  await expect(row).toContainText(
    "The MCP adapter is optional and is not enabled by this selection.",
  );
  await row.getByRole("button", { name: "Exclude MarkItDown CLI from setup", exact: true }).click();
  await expect(row).toContainText("Excluded by policy");
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).developerTools,
  ).toMatchObject({
    excluded: ["markitdown"],
  });
  await row.getByRole("button", { name: "Include MarkItDown CLI in setup", exact: true }).click();
  await expect(row).toContainText("Selected — pending setup");

  await page.locator('[data-sanctioned-cli="claude"]').click();
  await expect(page.locator("#supported-cli-count")).toContainText("1 selected");
  await page.locator("#posture").selectOption("enterprise");
  expect(
    JSON.parse(await page.locator("#config-preview").inputValue()).governance.supportedClis,
  ).toEqual(["claude"]);
  await page
    .getByRole("button", { name: "Add to draft for Code Review Graph", exact: true })
    .click();
  const toggle = page.locator("#managed-mcp-projection");
  await toggle.check();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.locator("#announcement")).toContainText(
    "Remove those controls before disabling this setting.",
  );
  await page
    .getByRole("button", { name: "Remove my choice for Code Review Graph", exact: true })
    .click();
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
    await row.getByRole("button", { name: "Include MarkItDown CLI in setup", exact: true }).click();
    await expect(row).toContainText("Selected — pending setup");
    const evidence = page.locator("#evidence-delivery");
    await evidence.locator("summary").click();
    const close = page.getByRole("button", { name: "Close evidence and versions", exact: true });
    await expect(close).toBeInViewport();
    await close.click();
    await expect(evidence).not.toHaveAttribute("open", "");
    await page.locator("#supported-cli-info").click();
    const note = page.locator("#supported-cli-note");
    await expect(note).toBeInViewport();
    expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
  }
});
