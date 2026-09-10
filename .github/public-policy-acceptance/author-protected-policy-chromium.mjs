import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const emptyFormFields = new Set(["protected-accepted-findings", "protected-accepted-gaps"]);

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`chromium-author-${label}-missing`);
  return value;
}

async function fillFields(page, fields) {
  const selects = [
    "protected-kind",
    "protected-source-type",
    "protected-qualification-kind",
    "protected-disposition",
  ];
  for (const id of selects) {
    if (fields[id] === undefined) continue;
    const control = page.locator(`#${id}`);
    if (await control.count() !== 1) throw new Error(`chromium-author-field-count:${id}`);
    await control.selectOption(requireText(fields[id], id));
  }
  for (const [id, value] of Object.entries(fields)) {
    if (selects.includes(id)) continue;
    const control = page.locator(`#${id}`);
    if (await control.count() !== 1) throw new Error(`chromium-author-field-count:${id}`);
    if (typeof value !== "string" || (value.length === 0 && !emptyFormFields.has(id)))
      throw new Error(`chromium-author-${id}-missing`);
    await control.fill(value);
  }
}

async function waitForExpectedRevocations(page, expectedDecisionDigests) {
  await page.waitForFunction(
    (expected) => {
      const preview = document.getElementById("protected-bundle-preview");
      if (!(preview instanceof HTMLTextAreaElement || preview instanceof HTMLInputElement)) return false;
      try {
        const parsed = JSON.parse(preview.value);
        const revocations = parsed?.authorityReceipt?.decisionRevocations;
        return Array.isArray(revocations)
          && revocations.length === expected.length
          && expected.every((digest) => revocations.some((entry) => entry?.decisionDigest === digest));
      } catch {
        return false;
      }
    },
    expectedDecisionDigests,
    { timeout: 10_000 },
  );
}

/**
 * Drives the packed Workbench in a real headless Chromium context. It never
 * assigns to page state, intercepts a URL/anchor, or writes authority JSON;
 * the only authority bytes come from Chromium's native download event.
 */
export async function authorProtectedPolicyViaChromium({
  htmlPath,
  outputPath,
  reportPath,
  screenshotPath,
  authorityFields,
  decisions,
  revokeDecisionIndexes = [],
  expectedRevocationDecisionDigests = [],
}) {
  for (const [label, value] of Object.entries({ htmlPath, outputPath, reportPath, screenshotPath }))
    requireText(value, label);
  if (!Array.isArray(decisions) || decisions.length === 0) throw new Error("chromium-author-decisions-missing");
  if (!Array.isArray(expectedRevocationDecisionDigests) || expectedRevocationDecisionDigests.some((digest) => typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)))
    throw new Error("chromium-author-revocation-digests-invalid");
  if (new Set(expectedRevocationDecisionDigests).size !== expectedRevocationDecisionDigests.length)
    throw new Error("chromium-author-revocation-digests-duplicate");

  const htmlBytes = readFileSync(htmlPath);
  const consoleErrors = [];
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(`console:${message.text()}`);
    });
      page.on("pageerror", (error) => consoleErrors.push(`pageerror:${error.message}`));
    await page.goto(pathToFileURL(resolve(htmlPath)).href, { waitUntil: "load" });
    const targets = new Set(
      [authorityFields, ...decisions]
        .flatMap((fields) => String(fields["protected-targets"] ?? "").split(","))
        .map((target) => target.trim())
        .filter(Boolean),
    );
    if (targets.size === 0) throw new Error("chromium-author-targets-missing");
    for (const target of targets) {
      const control = page.locator(`[data-sanctioned-cli="${target}"]`);
      if (await control.count() !== 1) throw new Error(`chromium-author-sanctioned-target:${target}`);
      if (await control.getAttribute("aria-pressed") !== "true") await control.click();
      if (await control.getAttribute("aria-pressed") !== "true") throw new Error(`chromium-author-target-not-sanctioned:${target}`);
    }
    await page.locator("#posture").selectOption("enterprise");
    if (await page.locator("#posture").inputValue() !== "enterprise")
      throw new Error("chromium-author-enterprise-posture-refused");
    const authorTab = page.locator('[data-view-tab="author"]');
    if (await authorTab.count() !== 1) throw new Error("chromium-author-view-tab-missing");
    await authorTab.click();
    await page.locator('body[data-view="author"]').waitFor({ state: "attached" });
    await page.locator("#protected-form").waitFor({ state: "visible" });
    if (await page.locator("#protected-form textarea:not([readonly]):not(#protected-conditions)").count() !== 0)
      throw new Error("chromium-author-raw-json-authoring-exposed");

    const form = page.locator("#protected-form");
    for (let index = 0; index < decisions.length; index += 1) {
      await fillFields(page, { ...authorityFields, ...decisions[index] });
      await form.locator('button[type="submit"]').click();
      await page.locator(`[data-protected-revoke="${index}"]`).waitFor({ state: "visible" });
    }
    for (const index of revokeDecisionIndexes) {
      const button = page.locator(`[data-protected-revoke="${String(index)}"]`);
      await button.waitFor({ state: "visible" });
      await button.click();
    }

    await waitForExpectedRevocations(page, expectedRevocationDecisionDigests);
    const previewAfterRevocation = await page.locator("#protected-bundle-preview").inputValue();
    const previewBundle = JSON.parse(previewAfterRevocation);
    const revocations = previewBundle?.authorityReceipt?.decisionRevocations;
    if (!Array.isArray(revocations) || revocations.length !== expectedRevocationDecisionDigests.length)
      throw new Error("chromium-author-revocation-count-mismatch");
    for (const digest of expectedRevocationDecisionDigests) {
      if (!revocations.some((entry) => entry?.decisionDigest === digest))
        throw new Error(`chromium-author-revocation-digest-missing:${digest}`);
    }

    const conditionsSection = page.locator("label").filter({ has: page.locator("#protected-conditions") });
    if (await conditionsSection.count() !== 1) throw new Error("chromium-author-conditions-section-missing");
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await conditionsSection.screenshot({ path: screenshotPath });

    const preview = await page.locator("#protected-bundle-preview").inputValue();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#download-protected-bundle").click(),
    ]);
    if (download.suggestedFilename() !== "aih-policy-bundle.json")
      throw new Error(`chromium-author-download-name:${download.suggestedFilename()}`);
    mkdirSync(dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const downloadedBytes = readFileSync(outputPath);
    if (!Buffer.from(preview, "utf8").equals(downloadedBytes))
      throw new Error("chromium-author-download-preview-mismatch");
    if (consoleErrors.length !== 0) throw new Error(`chromium-author-console-errors:${consoleErrors.join("|")}`);

    const report = {
      format: "aih-protected-policy-chromium-authoring-report/v1",
      browser: { engine: "chromium", version: browser.version(), headless: true, freshContext: true },
      html: { path: resolve(htmlPath), sha256: sha256(htmlBytes) },
      download: { path: resolve(outputPath), filename: download.suggestedFilename(), sha256: sha256(downloadedBytes) },
      conditionsScreenshot: {
        path: resolve(screenshotPath),
        sha256: sha256(readFileSync(screenshotPath)),
        scope: "The protected-conditions label and textarea only; actor, attestor, and issuer fields are excluded.",
      },
      consoleErrors,
      limitations: "Browser form/download mechanics only; no accessibility, visual-regression, or production claim.",
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
      return { bundle: JSON.parse(downloadedBytes.toString("utf8")), report };
    } finally {
      if (context !== undefined) await context.close();
    }
  } finally {
    if (browser !== undefined) await browser.close();
  }
}
