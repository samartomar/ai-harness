import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { parseProjectPolicyV1 } from "../../../../src/org-policy/project-policy.js";

const OFFLINE_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">`;

async function openUserDoor(page: Page, artifact: string, outputPath: string) {
  const directory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
  if (!directory) throw new Error("Workbench fixtures were not prepared");
  const html = await readFile(resolve(directory, artifact), "utf8");
  await writeFile(outputPath, html.replace("<head>", `<head>${OFFLINE_CSP}`));
  const pageErrors: string[] = [];
  const network: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) network.push(request.url());
  });
  await page.context().route(/^https?:/u, (route) => route.abort());
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__aihCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  });
  await page.goto(pathToFileURL(outputPath).href);
  return { pageErrors, network };
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __aihCspViolations: string[] }).__aihCspViolations,
  );
}

test("user door trims the org policy and downloads a valid aih-project-policy.json", async ({
  page,
}, testInfo) => {
  const probe = await openUserDoor(page, "user-door.html", testInfo.outputPath("user-door.html"));
  await expect(page.locator("#user-door")).toBeVisible();
  await expect(page.locator("#framework-rows")).toHaveCount(0);
  await expect(page.locator("#user-policy-source")).toContainText("aih-org-policy.json");
  await expect(page.locator("#user-policy-source")).toHaveAttribute("data-valid", "true");

  const rows = page.locator("#user-trim-list > li");
  expect(await rows.count()).toBeGreaterThan(2);
  const first = rows.nth(0);
  const second = rows.nth(1);
  const firstId = await first.getAttribute("data-asset-id");
  const secondId = await second.getAttribute("data-asset-id");
  await first.getByRole("radio", { name: "Required", exact: true }).click();
  await expect(first).toHaveAttribute("data-use", "required");
  await second.getByRole("radio", { name: "Optional", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(second.getByRole("radio", { name: "Skip", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(second.getByRole("radio", { name: "Skip", exact: true })).toBeFocused();
  await expect(second).toHaveAttribute("data-use", "skip");

  await expect(page.locator("#user-for-name")).toHaveAttribute("aria-required", "true");
  await expect(page.locator("#user-save")).toHaveAttribute("aria-describedby", "user-save-message");
  await page.locator("#user-for-name").fill("Payments API");
  await page.locator("#user-ai-tool-claude").check();
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const downloadEvent = page.waitForEvent("download");
  await page.locator("#user-save").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("aih-project-policy.json");
  const path = await download.path();
  if (path === null) throw new Error("Expected the project policy download");
  const saved = parseProjectPolicyV1(JSON.parse(await readFile(path, "utf8")));
  expect(saved.for).toEqual({ type: "project", name: "Payments API" });
  expect(saved.aiTools).toEqual(["claude"]);
  expect(saved.items.find((item) => item.assetId === firstId)?.use).toBe("required");
  expect(saved.items.some((item) => item.assetId === secondId)).toBe(false);
  expect(saved.items.length).toBe((await rows.count()) - 1);
  await expect(page.locator("#user-save-message")).toContainText("Download started");

  expect(await violations(page)).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
  expect(probe.network).toEqual([]);
});

test("user door fails closed on an invalid policy source", async ({ page }, testInfo) => {
  const probe = await openUserDoor(
    page,
    "user-door-invalid.html",
    testInfo.outputPath("user-door-invalid.html"),
  );
  await expect(page.locator("#user-policy-source")).toHaveAttribute("data-valid", "false");
  await expect(page.locator("#user-source-error")).toContainText(
    "Policy binding is invalid: <marker>",
  );
  await expect(page.locator("#user-save")).toBeDisabled();
  await expect(page.locator("#user-trim-list > li")).toHaveCount(0);
  expect(await page.locator("marker").count()).toBe(0);
  expect(await violations(page)).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
});
