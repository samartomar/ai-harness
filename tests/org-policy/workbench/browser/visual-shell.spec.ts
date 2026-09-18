import { expect, test } from "./fixture.js";

test.use({ viewport: { width: 1440, height: 900 } });

// Pixel baselines exist only for win32 so far; font rendering differs on the
// Linux and macOS CI runners, which need their own baselines generated there.
test.skip(
  process.platform !== "win32",
  "visual baselines are win32-only until CI generates linux/darwin ones",
);

async function disableTransitions(page: import("@playwright/test").Page): Promise<void> {
  await page.addStyleTag({ content: "*{transition:none!important;animation:none!important}" });
}

async function toggleTheme(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#theme-toggle").click();
  await disableTransitions(page);
}

for (const theme of ["light", "dark"] as const) {
  test(`admin shell header and kind ledger match the ${theme} baseline`, async ({
    page,
    workbench,
  }) => {
    await disableTransitions(page);
    if (theme === "dark") await toggleTheme(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    const header = page.locator("header.bar");
    const ledger = page.locator("[data-kind-ledger]");
    await expect(header).toBeVisible();
    await expect(ledger).toBeVisible();

    await expect(header).toHaveScreenshot(`shell-header-${theme}.png`, {
      maxDiffPixelRatio: 0.01,
      mask: [page.locator("#status")],
    });
    await expect(ledger).toHaveScreenshot(`shell-kind-ledger-${theme}.png`, {
      maxDiffPixelRatio: 0.01,
    });

    // No header overflow at desktop width (allow < 1px of subpixel rounding).
    const desktopMetrics = await header.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
    expect(Math.abs(desktopMetrics.height - desktopMetrics.scrollHeight)).toBeLessThan(1.5);

    // No header overflow at narrow (mobile) width either.
    await page.setViewportSize({ width: 375, height: 900 });
    const narrowMetrics = await header.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
    expect(Math.abs(narrowMetrics.height - narrowMetrics.scrollHeight)).toBeLessThan(1.5);

    // Restore viewport in case Playwright reuses page state across assertions.
    await page.setViewportSize({ width: 1440, height: 900 });
    void workbench;
  });
}
