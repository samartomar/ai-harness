import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./fixture.js";

// NEW-SHELL-PLAN.md S1: the new admin shell frame and screen router.
test.use({ shell: "new" });

const STRICT_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">`;

async function reopenUnderStrictCsp(
  page: import("@playwright/test").Page,
  path: string,
  search = "",
): Promise<void> {
  const strictHtml = (await readFile(path, "utf8")).replace("<head>", `<head>${STRICT_CSP}`);
  await writeFile(path, strictHtml);
  await page.addInitScript(() => {
    const probe = { violations: [] as string[] };
    Object.defineProperty(window, "__aihBrowserBoundaryProbe", { value: probe });
    document.addEventListener("securitypolicyviolation", (event) => {
      probe.violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  });
  await page.goto(pathToFileURL(path).href + search);
}

async function violations(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __aihBrowserBoundaryProbe: { violations: string[] } })
        .__aihBrowserBoundaryProbe.violations,
  );
}

test("renders the frame offline under a strict CSP and routes between screens", async ({
  page,
  workbench,
}) => {
  await reopenUnderStrictCsp(page, workbench.path);
  const root = page.locator("#wb-root");
  await expect(root).toHaveAttribute("data-wb-screen", "sources");
  await expect(page.locator("html")).toHaveAttribute("data-wb-shell", "new");
  await expect(page.getByRole("banner", { name: "Policy workbench toolbar" })).toBeVisible();
  await expect(page.locator("#status")).toHaveText("Ready - no repository is required.");
  await expect(page.locator("[data-kind-ledger-tile]")).toHaveCount(5);
  await expect(page.locator('[data-wb-screen-panel="sources"]')).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Workbench screens" });
  await nav.getByRole("button", { name: "Scan Review" }).click();
  await expect(root).toHaveAttribute("data-wb-screen", "scan");
  await expect(page.locator('[data-wb-screen-panel="scan"]')).toBeVisible();
  await expect(page.locator('[data-wb-screen-panel="sources"]')).toBeHidden();
  await expect(nav.getByRole("button", { name: "Scan Review" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(root).toHaveAttribute("data-wb-screen", "changes");

  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("tab", { name: "Security" }).click();
  await expect(page.getByRole("tab", { name: "Security" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Toggle inspector" }).click();
  await expect(page.locator("#inspector-rail")).toBeHidden();
  await page.getByRole("button", { name: "Toggle inspector" }).click();
  await expect(page.locator("#inspector-rail")).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(page.locator("#nav-rail")).toBeHidden();

  expect(await violations(page)).toEqual([]);
  expect(workbench.networkRequests).toEqual([]);
});

test("fits a 375 px viewport without horizontal scroll", async ({ page, workbench }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(pathToFileURL(workbench.path).href);
  await expect(page.locator("#wb-root")).toHaveAttribute("data-wb-screen", "sources");
  await expect(page.locator("#nav-rail")).toBeHidden();
  await expect(page.locator("#inspector-rail")).toBeHidden();
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    header: (() => {
      const header = document.querySelector("[data-wb-header]");
      return header === null ? -1 : header.scrollWidth - header.clientWidth;
    })(),
  }));
  expect(overflow).toEqual({ page: 0, header: 0 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(page.locator("#nav-rail")).toBeVisible();
});

test("renders the same frame from a legacy page opened with ?shell=new", async ({
  page,
  workbench,
}) => {
  const directory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
  if (!directory) throw new Error("Workbench fixtures were not prepared");
  const legacyPath = workbench.path.replace(/\.html$/u, ".legacy.html");
  await writeFile(legacyPath, await readFile(resolve(directory, "aih-policy-workbench.html")));
  await reopenUnderStrictCsp(page, legacyPath, "?shell=new");
  await expect(page.locator("html")).toHaveAttribute("data-wb-shell", "new");
  await expect(page.locator("#wb-root")).toHaveAttribute("data-wb-screen", "sources");
  await expect(page.locator("#wb-root")).toHaveCount(1);
  await expect(page.locator("#framework-rows")).toHaveCount(0);
  await expect(page.locator("[data-kind-ledger-tile]")).toHaveCount(5);
  expect(await violations(page)).toEqual([]);
});

// NEW-SHELL-PLAN.md S2: policy session and file transfer in a real browser.
test("imports, checks and publishes the policy with the preview bytes", async ({
  page,
  workbench,
}, testInfo) => {
  await reopenUnderStrictCsp(page, workbench.path);
  const bytes = await page.locator("#config-preview").inputValue();
  expect(JSON.parse(bytes).schemaVersion).toBeGreaterThanOrEqual(2);

  await page.locator("#policy-file").setInputFiles({
    name: "round-trip.json",
    mimeType: "application/json",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator("#announcement")).toContainText("Policy imported");
  await expect(page.locator("#config-preview")).toHaveValue(bytes);

  await page.locator("#policy-file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("[]"),
  });
  await expect(page.locator("#announcement")).toHaveText(
    "Policy import rejected: file import JSON root must be an object",
  );
  await expect(page.locator("#config-preview")).toHaveValue(bytes);

  await page.locator("#validate").click();
  await expect(page.locator("#announcement")).toContainText(
    "Schema and policy-grammar validation passed",
  );

  await page.getByRole("button", { name: "Policy files" }).click();
  await expect(page.locator("#wb-file-menu")).toBeVisible();
  await page.locator("#export").click();
  await expect(page.locator("#wb-root")).toHaveAttribute("data-wb-screen", "changes");
  await expect(page.locator("#config-preview")).toBeVisible();

  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("aih-org-policy.json");
  const path = testInfo.outputPath("downloaded-policy.json");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(bytes);
  await expect(page.locator("#announcement")).toHaveText(
    "Policy download started. Validate this file with: aih policy validate <target-root> --policy aih-org-policy.json",
  );
  expect(await violations(page)).toEqual([]);
});

test("keeps Check Policy and Publish disabled for an invalid prepared catalog", async ({
  page,
  workbench,
}) => {
  const directory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
  if (!directory) throw new Error("Workbench fixtures were not prepared");
  for (const missing of ["workbenchBundle", "workbenchBindings", "both"]) {
    await page.goto(pathToFileURL(resolve(directory, "new-shell", `invalid-${missing}.html`)).href);
    await expect(page.getByRole("alert")).toContainText("Prepared catalog is invalid");
    await expect(page.locator("#validate")).toBeDisabled();
    await expect(page.locator("#download")).toBeDisabled();
    const before = await page.locator("#config-preview").inputValue();
    await page.locator("#policy-file").setInputFiles({
      name: "rejected.json",
      mimeType: "application/json",
      buffer: Buffer.from(before),
    });
    await expect(page.locator("#announcement")).toContainText("Prepared catalog is invalid");
    expect(await page.locator("#config-preview").inputValue()).toBe(before);
  }
  await page.goto(pathToFileURL(resolve(directory, "new-shell", "invalid-policy.html")).href);
  const invalidInitial = await page.locator("#config-preview").inputValue();
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.locator("#validate").click();
  await expect(page.locator("#announcement")).toContainText(/maxTurns|schema variant/u);
  await expect(page.locator("#validate")).toHaveClass(/check-failed/u);
  expect(await page.locator("#validate").getAttribute("title")).toMatch(/^Policy check failed: /u);
  await page.locator("#download").click();
  await expect(page.locator("#announcement")).toContainText(/maxTurns|schema variant/u);
  expect(downloads).toEqual([]);
  expect(await page.locator("#config-preview").inputValue()).toBe(invalidInitial);
  void workbench;
});
