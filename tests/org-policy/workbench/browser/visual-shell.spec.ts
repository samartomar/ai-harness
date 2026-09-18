import { expect, test } from "./fixture.js";

test.use({ viewport: { width: 1440, height: 900 } });

// Pixel baselines exist only for win32 so far; font rendering differs on the
// Linux and macOS CI runners, which need their own baselines generated there.
test.skip(
  process.platform !== "win32",
  "visual baselines are win32-only until CI generates linux/darwin ones",
);

async function disableTransitions(page: import("@playwright/test").Page): Promise<void> {
  // Pin the ledger to whole pixels: its sub-pixel offset otherwise follows the
  // height of whatever content sits above it and flips the image size.
  await page.addStyleTag({
    content: "*{transition:none!important;animation:none!important}[data-kind-ledger]{height:44px}",
  });
}

async function toggleTheme(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#theme-toggle").click();
  await disableTransitions(page);
}

// The legacy header and kind-ledger screenshots retired with the legacy shell
// (id-contract.md, slice B); their overflow check runs on the new header.
test("admin shell header does not overflow at 1440 and 375 px", async ({ page, workbench }) => {
  const header = page.locator("[data-wb-header]");
  await expect(header).toBeVisible();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await header.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
    expect(Math.abs(metrics.height - metrics.scrollHeight)).toBeLessThan(1.5);
  }
  void workbench;
});

// NEW-SHELL-PLAN.md §3: the new shell's frame baselines.
test.describe("new shell", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`new shell frame matches the ${theme} baseline`, async ({ page, workbench }) => {
      await disableTransitions(page);
      if (theme === "dark") await toggleTheme(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("#wb-root")).toHaveAttribute("data-wb-screen", "sources");
      await expect(page).toHaveScreenshot(`new-shell-frame-${theme}.png`, {
        maxDiffPixelRatio: 0.01,
        mask: [page.locator("#status")],
      });
      void workbench;
    });
  }

  test("new shell frame matches the 375 px baseline", async ({ page, workbench }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await disableTransitions(page);
    await expect(page.locator("#wb-root")).toHaveAttribute("data-wb-screen", "sources");
    await expect(page).toHaveScreenshot("new-shell-frame-375-light.png", {
      maxDiffPixelRatio: 0.01,
      mask: [page.locator("#status")],
    });
    void workbench;
  });
});
