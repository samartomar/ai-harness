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
  // S3: the legacy markup is gone and #framework-rows is the sources screen's catalog.
  await expect(page.locator("[data-view-tab]")).toHaveCount(0);
  await expect(page.locator('[data-wb-screen-panel="sources"] #framework-rows')).toHaveCount(1);
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

// NEW-SHELL-PLAN.md S5: the changes screen.
test("shows the draft's changes, the whole file and copies the JSON offline", async ({
  page,
  context,
  workbench,
}) => {
  await reopenUnderStrictCsp(page, workbench.path);
  const preview = page.locator("#config-preview");
  const before = await preview.inputValue();
  await page.locator("button[data-workbench-row-action]").first().click();
  const selected = await preview.inputValue();
  expect(selected).not.toBe(before);

  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  const screen = page.locator('[data-wb-screen-panel="changes"]');
  await expect(screen).toBeVisible();
  await expect(screen.locator("#config-preview")).toBeVisible();
  await expect(screen.locator("[data-wb-changes-count]")).toHaveText(/^\d+ changed lines?$/u);

  await screen.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(screen.locator("#json-editor")).toBeHidden();
  const diff = screen.getByRole("region", { name: "Changes from the starting policy" });
  await expect(diff).toBeVisible();
  await expect(diff.locator('[data-wb-diff-line="added"]').first()).toBeVisible();
  await expect(preview).toHaveValue(selected);

  await screen.getByRole("button", { name: "Whole file", exact: true }).click();
  await expect(screen.locator("#config-preview")).toBeVisible();
  await expect(diff).toBeHidden();

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await screen.getByRole("button", { name: "Copy JSON" }).click();
  await expect(page.locator("#announcement")).toHaveText("Policy JSON copied to the clipboard.");

  await screen.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.locator("#workbench-detail-panel")).toHaveAttribute(
    "data-workbench-inspector-view",
    "draft",
  );
  await expect(preview).toHaveValue(selected);
  expect(await violations(page)).toEqual([]);
  expect(workbench.networkRequests).toEqual([]);
});

// Scan screen (NEW-SHELL-PLAN.md admin-scan).
test("inspects imported evidence and a decision on the scan screen offline", async ({
  page,
  workbench,
}) => {
  await reopenUnderStrictCsp(page, workbench.path);
  const preview = page.locator("#config-preview");
  const before = await preview.inputValue();
  await page
    .getByRole("navigation", { name: "Workbench screens" })
    .getByRole("button", { name: "Scan Review" })
    .click();
  const screen = page.locator('[data-wb-screen-panel="scan"]');
  await expect(screen.locator("#receipt-state")).toHaveText("No authority receipt imported.");
  await page.locator("#evidence-file").setInputFiles({
    name: "audit.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        approvals: [{ id: "approval-browser", issuer: "security-team" }],
        evidence: [{ id: "evidence-browser", state: "failed", note: "<img src=x>" }],
      }),
    ),
  });
  await expect(screen.locator("#approval-rows")).toContainText("approval-browser");
  await expect(screen.locator("#approval-rows")).toContainText(
    "failed evidence — preserved/preflight-only",
  );
  await expect(screen.locator("#approval-rows img")).toHaveCount(0);
  await expect(screen.locator("#receipt-state")).toContainText("preflight only");
  await expect(screen.locator("#copy-approvals")).toBeDisabled();
  await screen.locator("[data-wb-scan-finding-model] > summary").click();
  await expect(screen.locator("#hard-blockers")).toBeVisible();
  await expect(preview).toHaveValue(before);
  expect(await violations(page)).toEqual([]);
  expect(workbench.networkRequests).toEqual([]);
});

// S7 byte gate (NEW-SHELL-PLAN.md §5): the protected bundle and the artifact
// intake come out of the new shell's real controls, in a browser, and match the
// S0 goldens byte for byte. The page is the S0 characterization model.
test.describe("additions screen downloads", () => {
  test.use({ artifact: "golden-downloads.html" });

  const golden = (name: string) =>
    readFile(resolve("tests/org-policy/workbench/goldens", name), "utf8");
  const digest = (character: string) => `sha256:${character.repeat(64)}`;

  test("builds and downloads the protected bundle and the artifact intake byte for byte", async ({
    page,
    workbench,
  }) => {
    await reopenUnderStrictCsp(page, workbench.path);
    await page
      .getByRole("navigation", { name: "Workbench screens" })
      .getByRole("button", { name: "Additions & Approvals" })
      .click();
    const screen = page.locator('[data-wb-screen-panel="acme"]');
    await expect(screen.locator("#protected-form")).toBeVisible();
    const fields: Record<string, string> = {
      "protected-bundle-version": "acme-policy-1",
      "protected-issuer-repository": "acme/aih-policy",
      "protected-issuer": "acme-security",
      "protected-issued-at": "2026-08-26T12:00:00Z",
      "protected-expires-at": "2026-09-25T12:00:00Z",
      "protected-decision-id": "decision-acme-linter-1",
      "protected-subject-id": "acme-linter",
      "protected-source-repository": "acme/linter",
      "protected-source-commit": "a".repeat(40),
      "protected-source-path": "packages/cli",
      "protected-targets": "codex",
      "protected-effects": "observe,use",
      "protected-evidence-id": "acme-scan-001",
      "protected-evidence-digest": digest("b"),
      "protected-attestor": "acme-scanner",
      "protected-policy-id": "enterprise-policy",
      "protected-policy-version": "1",
      "protected-policy-digest": digest("c"),
      "protected-control-id": "tool-admission",
      "protected-control-digest": digest("d"),
      "protected-actor": "ruchi.admin@acme.example",
      "protected-reason": "Approved after attributable scanner evidence review",
    };
    await screen.locator("#protected-kind").selectOption("tool");
    for (const [id, entry] of Object.entries(fields)) await screen.locator(`#${id}`).fill(entry);
    await screen.locator("#protected-form button[type=submit]").click();
    const downloadBundle = screen.locator("#download-protected-bundle");
    await expect(downloadBundle).toBeEnabled();
    const bundleDownload = page.waitForEvent("download");
    await downloadBundle.click();
    const bundle = await bundleDownload;
    expect(bundle.suggestedFilename()).toBe("aih-policy-bundle.json");
    const bundlePath = test.info().outputPath("aih-policy-bundle.json");
    await bundle.saveAs(bundlePath);
    expect(await readFile(bundlePath, "utf8")).toBe(await golden("aih-policy-bundle.json"));
    // Pinned as the legacy runtime behaves (evidenceEnvelope is always null).
    await expect(screen.locator("#download-protected-evidence")).toBeDisabled();
    await expect(screen.locator("#protected-evidence-preview")).toHaveValue("");

    const intake = {
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-mcp",
          kind: "mcp",
          source: {
            type: "npm",
            registry: "https://registry.npmjs.org",
            package: "firecrawl-mcp",
            version: "3.24.0",
          },
        },
        {
          id: "acme-skill",
          kind: "skill",
          accountableOwner: "skills@acme.example",
          clarification: "Pinned review skill",
          source: {
            type: "github",
            repository: "acme/skills",
            commit: "b".repeat(40),
            path: "skills/review",
          },
        },
        {
          id: "pulse-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/acme",
          },
        },
      ],
    };
    const chooser = page.waitForEvent("filechooser");
    await screen.locator("#import-artifact-intake").click();
    await (await chooser).setFiles({
      name: "intake.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(intake)),
    });
    await expect(screen.locator("#artifact-intake-items")).toContainText("pulse-directory");
    const intakeDownload = page.waitForEvent("download");
    await screen.locator("#download-artifact-intake").click();
    const intakeFile = await intakeDownload;
    expect(intakeFile.suggestedFilename()).toBe("aih-artifact-intake.json");
    const intakePath = test.info().outputPath("aih-artifact-intake.json");
    await intakeFile.saveAs(intakePath);
    expect(await readFile(intakePath, "utf8")).toBe(await golden("aih-artifact-intake.json"));
    expect(await violations(page)).toEqual([]);
    expect(workbench.networkRequests).toEqual([]);
  });
});
