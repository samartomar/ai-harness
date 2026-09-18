import { pathToFileURL } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixture.js";

test.use({ artifact: "synthetic-1000.html", viewport: { width: 1440, height: 640 } });

type ScrollMetrics = {
  clientHeight: number;
  overflowY: string;
  scrollHeight: number;
  scrollTop: number;
};

async function scrollMetrics(locator: Locator): Promise<ScrollMetrics> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      overflowY: style.overflowY,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
}

async function pointInViewport(
  page: Page,
  target: Locator,
  label: string,
): Promise<{
  x: number;
  y: number;
}> {
  await target.scrollIntoViewIfNeeded();
  const [box, viewport] = await Promise.all([target.boundingBox(), page.viewportSize()]);
  if (box === null || viewport === null) throw new Error(`Expected visible ${label}`);
  const top = Math.max(1, box.y + 1);
  const bottom = Math.min(viewport.height - 1, box.y + box.height - 1);
  expect(bottom, `${label} needs a visible pointer target`).toBeGreaterThan(top);
  return {
    x: Math.min(viewport.width - 1, Math.max(1, box.x + Math.min(24, box.width / 2))),
    y: (top + bottom) / 2,
  };
}

/**
 * NEW-SHELL-PLAN.md S4 (orchestrator decision): the new shell scrolls its main
 * panel `#wb-main` (and the inspector rail its own panel) instead of the
 * document. The intent is unchanged: a wheel over a pane moves the shared
 * scroll container, never the pane itself, so all content stays reachable.
 */
async function expectWheelToMoveScroller(
  page: Page,
  scroller: Locator,
  target: Locator,
  label: string,
): Promise<void> {
  await target.evaluate((element) => {
    element.scrollTop = 0;
  });
  const point = await pointInViewport(page, target, label);
  await page.mouse.move(point.x, point.y);
  const before = (await scrollMetrics(scroller)).scrollTop;
  const metrics = await scrollMetrics(scroller);
  expect(metrics.overflowY, `${label} scroll container must scroll`).toBe("auto");
  expect(
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
    `${label} needs remaining scroll container content to scroll`,
  ).toBeGreaterThan(180);

  await page.mouse.wheel(0, 720);

  await expect
    .poll(() => scrollMetrics(scroller).then((next) => next.scrollTop), {
      message: `${label} wheel must move the scroll container`,
    })
    .toBeGreaterThan(before);
  expect((await scrollMetrics(target)).scrollTop, `${label} must not consume the wheel`).toBe(0);
  expect(await page.evaluate(() => window.scrollY), `${label} must not scroll the document`).toBe(
    0,
  );
}

async function expectNoDesktopPaneScroll(target: Locator, label: string): Promise<void> {
  const metrics = await scrollMetrics(target);
  expect(metrics.scrollHeight, `${label} must flow with the document`).toBeLessThanOrEqual(
    metrics.clientHeight + 1,
  );
}

// NEW-SHELL-PLAN.md S4: inspector-rail journeys moved to the new shell, assertions unchanged.
test.describe("new shell", () => {
  test.use({ shell: "new" });

  test("keeps the mobile Workbench inspector as its own scrollable drawer", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await page.setViewportSize({ width: 375, height: 360 });
    await page.getByRole("combobox", { name: "Choose catalog source" }).selectOption("source:a");
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    await page.locator("button.workbench-row-title[data-workbench-expand-id]").first().click();
    await expect(inspector).toBeVisible();
    const before = await scrollMetrics(inspector);
    expect(await inspector.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    expect(before.overflowY).toBe("auto");
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

    const documentBefore = await page.evaluate(() => window.scrollY);
    const point = await pointInViewport(page, inspector, "mobile inspector");
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 420);
    await expect
      .poll(() => scrollMetrics(inspector).then((metrics) => metrics.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(documentBefore);

    await inspector.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const drawerBottom = await scrollMetrics(inspector);
    const beforeBottomWheel = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 420);
    expect((await scrollMetrics(inspector)).scrollTop).toBe(drawerBottom.scrollTop);
    expect(await page.evaluate(() => window.scrollY)).toBe(beforeBottomWheel);
  });

  // S4 orchestrator decision: the new shell scrolls #wb-main, not the document.
  test("uses the main panel for desktop and narrow Workbench scrolling", async ({
    page,
    workbench,
  }) => {
    await expect(page).toHaveURL(pathToFileURL(workbench.path).href);
    await page.locator('[data-workbench-source-tab="source:a"]').click();

    const preview = page.locator("#config-preview");
    const beforeSelections = await preview.inputValue();
    const sourceRail = page.locator("[data-workbench-source-rail]");
    const catalog = page.locator('section[aria-label="Catalog inventory"]');
    const inspector = page.locator("#workbench-detail-panel[data-workbench-detail]");
    const main = page.locator("#wb-main");
    const inspectorPanel = page.locator("#wb-inspector-panel");
    const selectedAssetId = "scale:000009";
    const selectedAction = page.locator(
      `button[data-workbench-row-action][data-workbench-asset-id="${selectedAssetId}"]`,
    );
    await expect(selectedAction).toBeVisible();
    await selectedAction.click();
    const selectedPolicy = await preview.inputValue();
    expect(selectedPolicy).not.toBe(beforeSelections);
    await inspector.locator('[data-workbench-panel-view="exposure"]').click();
    await expect(
      inspector.locator(`[data-workbench-exposure-item-id="${selectedAssetId}"]`),
    ).toBeVisible();

    await expectWheelToMoveScroller(page, main, sourceRail, "source rail");
    await expectWheelToMoveScroller(page, main, catalog, "catalog");
    await expectWheelToMoveScroller(page, inspectorPanel, inspector, "inspector");
    await expectNoDesktopPaneScroll(sourceRail, "source rail");
    await expectNoDesktopPaneScroll(catalog, "catalog");
    await expectNoDesktopPaneScroll(inspector, "inspector");
    await expect(preview).toHaveValue(selectedPolicy);

    const deepInspect = page
      .locator("button.workbench-row-title[data-workbench-expand-id]")
      .nth(35);
    await deepInspect.scrollIntoViewIfNeeded();
    await deepInspect.click();
    const heading = inspector.locator("#workbench-detail-title");
    await expect(heading).toBeFocused();
    const headingBox = await heading.boundingBox();
    if (headingBox === null) throw new Error("Expected the opened inspector heading to be visible");
    expect(headingBox.y).toBeGreaterThanOrEqual(0);
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(640);
    await expect(preview).toHaveValue(selectedPolicy);

    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await expect(deepInspect).toBeFocused();
    const restoredRowBox = await deepInspect.boundingBox();
    if (restoredRowBox === null)
      throw new Error("Expected the opened catalog row to remain visible");
    expect(restoredRowBox.y).toBeGreaterThanOrEqual(0);
    expect(restoredRowBox.y + restoredRowBox.height).toBeLessThanOrEqual(640);
    await page.setViewportSize({ width: 900, height: 640 });
    await expect(catalog).toBeVisible();
    await expectWheelToMoveScroller(page, main, catalog, "narrow catalog");
    await expectNoDesktopPaneScroll(catalog, "narrow catalog");
    await expect(preview).toHaveValue(selectedPolicy);
  });
});
