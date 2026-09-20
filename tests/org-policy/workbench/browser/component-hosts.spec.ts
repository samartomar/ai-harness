import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  allowAiTool,
  bindProjectToPolicy,
  copyHostedSite,
  downloadOrgPolicy,
  expect,
  fixtureStudioModel,
  goToUserPage,
  importOrgPolicy,
  policyEvidence,
  refuseEnterpriseWithoutAiTool,
  saveProjectPolicy,
  selectFirstSelectableItem,
  serveStaticDirectory,
  setEnterprisePosture,
  sha256Of,
  startCliHost,
  test,
} from "./component-hosts-fixture.js";

/**
 * J1 and J2 on both PRODUCTION hosts (acceptance §3): the static hosted build
 * and the CLI host loaded from an installed candidate package. Nothing here
 * asserts a content-security policy in either direction.
 */

const GOLDENS = resolve("tests/org-policy/workbench/goldens");

function golden(name: string): Promise<string> {
  return readFile(join(GOLDENS, name), "utf8");
}

test.describe("the hosted production build", () => {
  test.setTimeout(180_000);

  test("J1 and J2 reproduce the byte anchors from the fixture input", async ({
    page,
    probe,
  }, testInfo) => {
    const site = await copyHostedSite(testInfo.outputPath("hosted-fixture"));
    await writeFile(
      join(site, "workbench-input.json"),
      JSON.stringify({
        format: "aih-workbench-input",
        version: 1,
        door: "admin",
        model: await fixtureStudioModel(),
      }),
    );
    const server = await serveStaticDirectory(site);
    try {
      probe.allow(server.origin);
      await page.goto(server.origin);
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();

      await refuseEnterpriseWithoutAiTool(page);
      await allowAiTool(page, "Claude Code");
      await setEnterprisePosture(page);
      await selectFirstSelectableItem(page, "fixture:control");
      const orgPolicy = await downloadOrgPolicy(page, testInfo.outputPath("aih-org-policy.json"));

      expect(orgPolicy.name).toBe("aih-org-policy.json");
      expect(orgPolicy.text).toBe(await golden("aih-org-policy.v3-selection.json"));

      await goToUserPage(page);
      await importOrgPolicy(page, orgPolicy.text, testInfo.outputPath("import.json"));
      const projectPolicy = await saveProjectPolicy(page, {
        item: "fixture:control",
        projectName: "Payments API",
        aiTool: "claude",
        outputPath: testInfo.outputPath("aih-project-policy.json"),
      });

      expect(projectPolicy.name).toBe("aih-project-policy.json");
      expect(projectPolicy.text).toBe(await golden("aih-project-policy.v3-selection.json"));

      // The same two files, checked in Node against the canonical schemas.
      const evidence = await policyEvidence(
        testInfo.outputPath("aih-org-policy.json"),
        testInfo.outputPath("aih-project-policy.json"),
      );
      expect(evidence.schemaVersion).toBe(3);
      expect(evidence.narrows).toEqual({ ok: true });
      expect(probe.foreign).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("J1 and J2 hold on the real package-only input, and the browser digest equals Node's for the same bytes", async ({
    page,
    probe,
  }, testInfo) => {
    const site = await copyHostedSite(testInfo.outputPath("hosted-real"));
    const server = await serveStaticDirectory(site);
    try {
      probe.allow(server.origin);
      await page.goto(server.origin);
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();

      await refuseEnterpriseWithoutAiTool(page);
      await allowAiTool(page);
      await setEnterprisePosture(page);
      const assetId = await selectFirstSelectableItem(page);
      const orgPolicy = await downloadOrgPolicy(page, testInfo.outputPath("real-org-policy.json"));

      const org = await policyEvidence(testInfo.outputPath("real-org-policy.json"));
      expect(org.schemaVersion).toBe(3);
      expect(org.authoringSelections).toContain(assetId);

      await goToUserPage(page);
      await importOrgPolicy(page, orgPolicy.text, testInfo.outputPath("real-import.json"));
      const projectPolicy = await saveProjectPolicy(page, {
        projectName: "Payments API",
        outputPath: testInfo.outputPath("real-project-policy.json"),
      });
      expect(projectPolicy.name).toBe("aih-project-policy.json");

      const evidence = await policyEvidence(
        testInfo.outputPath("real-org-policy.json"),
        testInfo.outputPath("real-project-policy.json"),
      );
      // The host digests the bytes it was handed; Node digests the same bytes.
      expect(evidence.cutFrom?.sha256).toBe(evidence.orgSha256);
      expect(evidence.cutFrom?.sha256).toBe(sha256Of(orgPolicy.text));
      expect(evidence.cutFrom?.schemaVersion).toBe(3);
      expect(evidence.narrows).toEqual({ ok: true });
      expect(probe.foreign).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("J4: every flyout opens from the keyboard, holds focus, and returns it", async ({
    page,
    probe,
  }, testInfo) => {
    const site = await copyHostedSite(testInfo.outputPath("hosted-keyboard"));
    const server = await serveStaticDirectory(site);
    try {
      probe.allow(server.origin);
      await page.goto(server.origin);
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();

      for (const [triggerName, dialogName] of [
        [/AI tools/u, "AI tools"],
        ["Review Changes", "Review changes"],
      ] as const) {
        const trigger = page.getByRole("button", { name: triggerName });
        await trigger.focus();
        await expect(trigger).toBeFocused();
        await page.keyboard.press("Enter");

        const dialog = page.getByRole("dialog", { name: dialogName });
        await expect(dialog).toBeVisible();
        for (let step = 0; step < 6; step += 1) {
          await page.keyboard.press("Tab");
          expect(
            await dialog.evaluate((node) => node.contains(document.activeElement)),
            `focus left the ${dialogName} flyout`,
          ).toBe(true);
        }

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
      }
      expect(probe.foreign).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

test.describe("the CLI host from the installed candidate package", () => {
  test.setTimeout(300_000);

  test("J1 on the admin door, J2 on the bound project door, and the token survives navigation", async ({
    page,
    probe,
  }, testInfo) => {
    // Product behaviour runs against temporary fixture roots, never this checkout.
    const adminRoot = testInfo.outputPath("cli-admin");
    await mkdir(adminRoot, { recursive: true });
    const admin = await startCliHost({
      cwd: adminRoot,
      preloadPath: testInfo.outputPath("cli-admin-preload.mjs"),
    });
    let orgPolicyText = "";
    try {
      probe.allow(admin.origin);
      await page.goto(admin.url);
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      const token = await page.evaluate(() => location.hash);
      expect(token).toMatch(/^#[a-f0-9]{64}$/u);

      await refuseEnterpriseWithoutAiTool(page);
      await allowAiTool(page);
      await setEnterprisePosture(page);
      const assetId = await selectFirstSelectableItem(page);
      const downloaded = await downloadOrgPolicy(page, testInfo.outputPath("cli-org-policy.json"));
      orgPolicyText = downloaded.text;

      const org = await policyEvidence(testInfo.outputPath("cli-org-policy.json"));
      expect(org.schemaVersion).toBe(3);
      expect(org.authoringSelections).toContain(assetId);

      // The request token lives in the fragment and survives query routing,
      // history navigation, and a reload.
      await goToUserPage(page);
      expect(await page.evaluate(() => location.search)).toBe("?page=user");
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.getByRole("link", { name: "Admin page" }).click();
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.goBack();
      expect(await page.evaluate(() => location.hash)).toBe(token);
      await page.goForward();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.reload();
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      // The offline file is self-contained: the document, and nothing else.
      expect(probe.subresources, "the component page fetched a subresource").toEqual([]);
      expect(probe.documents.length).toBeGreaterThan(0);
    } finally {
      await admin.stop();
    }

    // The user door needs a policy BINDING: an org policy file in the launch
    // folder itself would classify the folder as the admin door
    // (`classifyWorkbenchDoorV1`).
    const projectRoot = testInfo.outputPath("cli-project");
    const policyHome = testInfo.outputPath("cli-project-policy-home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(policyHome, { recursive: true });
    const policyPath = join(policyHome, "aih-org-policy.json");
    await writeFile(policyPath, orgPolicyText);
    const digest = await bindProjectToPolicy({
      projectRoot,
      policyPath,
      targets: ["claude"],
    });
    expect(digest).toBe(sha256Of(orgPolicyText));

    const user = await startCliHost({
      cwd: projectRoot,
      preloadPath: testInfo.outputPath("cli-user-preload.mjs"),
    });
    try {
      probe.allow(user.origin);
      await page.goto(user.url);
      await expect(page.getByRole("link", { name: "Admin page" })).toBeVisible();
      // A bound page needs no import control; its chip carries the digest.
      await expect(page.getByLabel("Import organization policy")).toHaveCount(0);
      await expect(page.getByText(digest.slice(0, 12), { exact: false })).toBeVisible();

      const projectPolicy = await saveProjectPolicy(page, {
        projectName: "Payments API",
        outputPath: testInfo.outputPath("cli-project-policy.json"),
      });
      expect(projectPolicy.name).toBe("aih-project-policy.json");
      const evidence = await policyEvidence(
        policyPath,
        testInfo.outputPath("cli-project-policy.json"),
      );
      expect(evidence.cutFrom?.sha256).toBe(digest);
      expect(evidence.cutFrom?.schemaVersion).toBe(3);
      expect(evidence.narrows).toEqual({ ok: true });
      expect(probe.subresources).toEqual([]);
    } finally {
      await user.stop();
    }
  });

  test("serves the self-contained component page, and the request token survives every navigation", async ({
    page,
    probe,
  }, testInfo) => {
    const root = testInfo.outputPath("cli-token");
    await mkdir(root, { recursive: true });
    const host = await startCliHost({
      cwd: root,
      preloadPath: testInfo.outputPath("cli-token-preload.mjs"),
    });
    try {
      probe.allow(host.origin);
      await page.goto(host.url);
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      const token = await page.evaluate(() => location.hash);
      expect(token).toMatch(/^#[a-f0-9]{64}$/u);
      expect(host.url.endsWith(token)).toBe(true);

      // The CLI host routes in the query, so the fragment that carries the
      // token is never rewritten.
      await goToUserPage(page);
      expect(await page.evaluate(() => location.search)).toBe("?page=user");
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.getByRole("link", { name: "Admin page" }).click();
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.goBack();
      await expect(page.getByRole("link", { name: "Admin page" })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.goForward();
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      await page.reload();
      await expect(page.getByRole("button", { name: "Review Changes" })).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(token);

      // One self-contained file: documents only, never a subresource.
      expect(probe.subresources, "the component page fetched a subresource").toEqual([]);
      expect(probe.documents.length).toBeGreaterThan(0);
    } finally {
      await host.stop();
    }
  });

  test("without the environment switch the installed package still serves the hand-built page", async ({
    page,
    probe,
  }, testInfo) => {
    const root = testInfo.outputPath("cli-default");
    await mkdir(root, { recursive: true });
    const host = await startCliHost({
      cwd: root,
      preloadPath: testInfo.outputPath("cli-default-preload.mjs"),
      componentUi: false,
    });
    try {
      probe.allow(host.origin);
      await page.goto(host.url);
      await expect(page.locator('#wb-root[data-wb-shell="new"]')).toBeAttached();
      await expect(page.locator("#aih-workbench-input")).toHaveCount(0);
    } finally {
      await host.stop();
    }
  });
});
