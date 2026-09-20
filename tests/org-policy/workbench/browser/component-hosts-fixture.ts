import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import {
  preparePackedWorkbench,
  startInstalledWorkbenchUi,
} from "../../../../tools/prepare-packed-workbench.mjs";

/**
 * The two PRODUCTION hosts of the component UI, in a real browser (Policy
 * Workbench UI delivery, "Real hosts"). The existing `fixture.ts` aborts every
 * http(s) request because the hand-built page is a local file; these hosts are
 * served over loopback, so this fixture allows exactly ONE origin — the host
 * under test — and fails on any other request.
 *
 * It does not require the `aih-workbench-ui/v1` coverage banner that the
 * hand-built page carries.
 */

/**
 * The offline policy for the component page: the offline policy the hand-built
 * page is tested under, plus exactly `font-src data:`, because the offline file
 * embeds the prototype's three fonts (owner decision).
 */
export const COMPONENT_OFFLINE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'";

/** The served page as a local file that carries the offline policy itself. */
export async function writeOfflineFileUnderPolicy(served: string, path: string): Promise<void> {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${COMPONENT_OFFLINE_POLICY}">`;
  const html = served.replace("<head>", () => `<head>${policy}`);
  if (html === served) throw new Error("The component page has no <head> to carry the policy");
  await writeFile(path, html);
}

/** Records every policy violation the page raises. Call before `goto`. */
export async function recordPolicyViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__aihCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __aihCspViolations: string[] }).__aihCspViolations);
}

export interface HostProbe {
  /** The one origin this page may talk to. Everything else is a failure. */
  allow(origin: string): void;
  readonly foreign: string[];
  /** Same-origin requests that are not the document itself. */
  readonly subresources: string[];
  readonly documents: string[];
  readonly pageErrors: string[];
}

interface ComponentHostFixtures {
  probe: HostProbe;
}

export const test = base.extend<ComponentHostFixtures>({
  probe: async ({ page, context }, use) => {
    let origin: string | undefined;
    const foreign: string[] = [];
    const subresources: string[] = [];
    const documents: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    page.on("request", (request) => {
      const url = request.url();
      if (!/^https?:/u.test(url)) return;
      if (origin === undefined || !url.startsWith(origin)) {
        foreign.push(url);
        return;
      }
      if (request.resourceType() === "document") documents.push(url);
      // `/favicon.ico` is the browser's own request for a displayed document,
      // not something the page asked for.
      else if (!new URL(url).pathname.endsWith("/favicon.ico")) subresources.push(url);
    });
    await context.route(/^https?:/u, (route) => {
      const url = route.request().url();
      if (origin !== undefined && url.startsWith(origin)) return route.continue();
      return route.abort();
    });
    await use({
      allow: (value) => {
        origin = value;
      },
      foreign,
      subresources,
      documents,
      pageErrors,
    });
    expect(foreign, "the page reached an origin other than its host").toEqual([]);
    expect(pageErrors, "the component page raised an error").toEqual([]);
  },
});

export { expect };

/* ------------------------------------------------------------------ hosts */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

export interface StaticSite {
  readonly origin: string;
  close(): Promise<void>;
}

/** The hosted site as a static server: correct types, no listing, no traversal. */
export async function serveStaticDirectory(root: string): Promise<StaticSite> {
  const base = resolve(root);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400, { "Content-Length": "0" });
      response.end();
      return;
    }
    const target = resolve(base, `.${decoded === "/" ? "/index.html" : decoded}`);
    if (target !== base && !target.startsWith(base + sep)) {
      response.writeHead(403, { "Content-Length": "0" });
      response.end();
      return;
    }
    readFile(target).then(
      (body) => {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": String(body.byteLength),
          "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
      },
      () => {
        // A directory read fails the same way a missing file does: no listing.
        response.writeHead(404, { "Content-Length": "0" });
        response.end();
      },
    );
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((closed, failed) =>
        server.close((error) => (error === undefined ? closed() : failed(error))),
      ),
  };
}

let hostedBuild: Promise<string> | undefined;

/** The production hosted build, built once per worker by its own build tool. */
export function buildHostedOnce(): Promise<string> {
  const started =
    hostedBuild ??
    promisify(execFile)(process.execPath, ["tools/build-workbench-ui.mjs", "--hosted"], {
      cwd: resolve("."),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }).then(() => resolve("workbench-ui/dist/hosted"));
  hostedBuild = started;
  return started;
}

/** A private copy of the hosted build, so a test may replace its input. */
export async function copyHostedSite(target: string): Promise<string> {
  await mkdir(target, { recursive: true });
  await cp(await buildHostedOnce(), target, { recursive: true });
  return target;
}

let packedInstall: Promise<string> | undefined;

/**
 * The installed candidate package: a cold consumer install of `npm pack`
 * output. Its own directory, so this spec never races the packed artifact
 * fixture of `fixture.ts`.
 */
export function installedCli(): Promise<string> {
  const started =
    packedInstall ??
    Promise.resolve().then(async () => {
      const directory = process.env.AIH_WORKBENCH_FIXTURE_DIR;
      if (!directory) throw new Error("Workbench fixtures were not prepared");
      const target = resolve(directory, "component-hosts-package");
      const cli = resolve(target, "packed-consumer/node_modules/@aihq/core/dist/cli.js");
      try {
        await readFile(cli);
        return cli;
      } catch {
        await mkdir(target, { recursive: true });
        await preparePackedWorkbench(target);
        return cli;
      }
    });
  packedInstall = started;
  return started;
}

export interface RunningCliHost {
  readonly url: string;
  readonly origin: string;
  stop(): Promise<void>;
}

/** `--ui` from the INSTALLED package, in a temporary folder, never this checkout. */
export async function startCliHost(options: {
  cwd: string;
  preloadPath: string;
  componentUi?: boolean;
}): Promise<RunningCliHost> {
  const cli = await installedCli();
  const started = await startInstalledWorkbenchUi({
    cli,
    cwd: options.cwd,
    preloadPath: options.preloadPath,
    env: options.componentUi === false ? {} : { AIH_WORKBENCH_COMPONENT_UI: "1" },
  });
  return {
    url: started.url,
    origin: new URL(started.url).origin,
    stop: started.stop,
  };
}

/* ----------------------------------------------------- Node-side evidence */

/**
 * The policy modules reach a JSON import that Playwright's loader will not
 * take, so the canonical schema work runs in a child Node process, the same
 * way the build tools load TypeScript.
 */
async function nodeJson(source: string, env: Record<string, string>): Promise<unknown> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: resolve("."),
      env: { ...process.env, ...env },
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as unknown;
}

/** The component tests' fixture model: the tiny catalog plus the two hosts. */
export async function fixtureStudioModel(): Promise<Record<string, unknown>> {
  return (await nodeJson(
    [
      'import { tinyStudioModel } from "./tests/org-policy/studio-test-fixture.ts";',
      "const model = tinyStudioModel();",
      'model.catalog.hosts = [{ id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },',
      '{ id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" }];',
      "process.stdout.write(JSON.stringify(model));",
    ].join("\n"),
    {},
  )) as Record<string, unknown>;
}

export interface PolicyEvidence {
  readonly schemaVersion: number;
  readonly authoringSelections: string;
  readonly orgSha256: string;
  readonly cutFrom?: { readonly sha256: string; readonly schemaVersion: number };
  readonly narrows?: { readonly ok: boolean; readonly reasons?: string[] };
}

/** Output A against `OrgPolicySchema`, output B against `ProjectPolicyV1Schema`. */
export function policyEvidence(orgPath: string, projectPath?: string): Promise<PolicyEvidence> {
  const source = [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { parseOrgPolicy } from "./src/org-policy/schema.ts";',
    'import { checkProjectPolicyNarrowsV1, parseProjectPolicyV1 } from "./src/org-policy/project-policy.ts";',
    "const orgBytes = readFileSync(process.env.AIH_CHECK_ORG);",
    'const org = parseOrgPolicy(JSON.parse(orgBytes.toString("utf8")));',
    'const orgSha256 = createHash("sha256").update(orgBytes).digest("hex");',
    "const out = { schemaVersion: org.schemaVersion, authoringSelections: JSON.stringify(org.authoringSelections ?? {}), orgSha256 };",
    "if (process.env.AIH_CHECK_PROJECT) {",
    '  const project = parseProjectPolicyV1(JSON.parse(readFileSync(process.env.AIH_CHECK_PROJECT, "utf8")));',
    "  out.cutFrom = project.cutFrom;",
    "  out.narrows = checkProjectPolicyNarrowsV1(project, org, orgSha256);",
    "}",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  return nodeJson(source, {
    AIH_CHECK_ORG: orgPath,
    ...(projectPath === undefined ? {} : { AIH_CHECK_PROJECT: projectPath }),
  }) as Promise<PolicyEvidence>;
}

/**
 * A project folder bound to an org policy — the CLI host's user door. The
 * policy file lives OUTSIDE the folder on purpose: an `aih-org-policy.json`
 * in the launch folder itself classifies that folder as the admin door
 * (`classifyWorkbenchDoorV1`). Only an active binding opens the user door.
 */
export async function bindProjectToPolicy(options: {
  projectRoot: string;
  policyPath: string;
  targets: readonly string[];
}): Promise<string> {
  const source = [
    'import { createHash, } from "node:crypto";',
    'import { readFileSync, realpathSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { policyRootSha256 } from "./src/org-policy/binding.ts";',
    "const root = process.env.AIH_BIND_ROOT;",
    "const policyPath = process.env.AIH_BIND_POLICY;",
    'const sha256 = createHash("sha256").update(readFileSync(policyPath)).digest("hex");',
    "writeFileSync(",
    '  join(root, ".aih-config.json"),',
    "  JSON.stringify({ policyBinding: {",
    '    schemaVersion: 1, state: "active", projectId: "payments-api",',
    "    rootSha256: policyRootSha256(realpathSync.native(root)),",
    "    source: { path: policyPath, sha256 },",
    "    targets: JSON.parse(process.env.AIH_BIND_TARGETS),",
    "  } }),",
    ");",
    "process.stdout.write(JSON.stringify({ sha256 }));",
  ].join("\n");
  const result = (await nodeJson(source, {
    AIH_BIND_ROOT: options.projectRoot,
    AIH_BIND_POLICY: options.policyPath,
    AIH_BIND_TARGETS: JSON.stringify(options.targets),
  })) as { sha256: string };
  return result.sha256;
}

export function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

/* --------------------------------------------------------------- journeys */

const ENTERPRISE_REFUSAL = "Enterprise posture was not applied.";
const MANAGED_MCP_BLOCKER = "enable managed MCP projection";
const MANAGED_MCP_SWITCH = "Allow AIH to configure selected MCP tools";
const CHECK_PASSED = "Schema and policy-grammar validation passed.";

function posture(page: Page, label: string): Locator {
  return page.getByRole("radiogroup", { name: "Posture" }).getByText(label, { exact: true });
}

/** J1 step 1: Enterprise before any AI tool is refused, and nothing changes. */
export async function refuseEnterpriseWithoutAiTool(page: Page): Promise<void> {
  await posture(page, "Enterprise").click();
  await expect(page.getByRole("alert").first()).toContainText(ENTERPRISE_REFUSAL);
  await expect(page.getByRole("radio", { name: "Vibe" })).toBeChecked();
}

/** Opens the AI tools flyout and allows one tool. Returns its label. */
export async function allowAiTool(page: Page, name?: string): Promise<string> {
  await page.getByRole("button", { name: /AI tools/u }).click();
  const flyout = page.getByRole("dialog", { name: "AI tools" });
  const tool =
    name === undefined ? flyout.getByRole("switch").first() : flyout.getByRole("switch", { name });
  const label = (await tool.getAttribute("aria-label")) ?? "";
  await tool.click();
  await expect(tool).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(flyout).toBeHidden();
  return label;
}

export async function setEnterprisePosture(page: Page): Promise<void> {
  await posture(page, "Enterprise").click();
  await expect(page.getByRole("radio", { name: "Enterprise" })).toBeChecked();
}

/** The engine's own verdict on the current draft, as the page reports it. */
async function checkPolicy(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Check Policy" }).click();
  // The engine always answers: a status when it passes, an alert when it does
  // not. Wait for whichever arrived before reading the refusal.
  await expect
    .poll(async () => {
      const status = (await page.getByRole("status").first().textContent()) ?? "";
      const alert = (await page.getByRole("alert").first().textContent()) ?? "";
      return status + alert;
    })
    .not.toBe("");
  const status = (await page.getByRole("status").first().textContent()) ?? "";
  const alert = (await page.getByRole("alert").first().textContent()) ?? "";
  // A blocker that does not fail the check is still reported, as a status.
  return status === CHECK_PASSED && alert === "" ? "" : `${status} ${alert}`.trim();
}

/**
 * Selects a catalog item by property: the first item whose switch is enabled
 * AND whose selection leaves the policy checkable. Some catalog items carry a
 * grammar blocker of their own (an MCP asset asks for managed projection
 * first); this journey selects an item, asks the engine, and moves on when the
 * engine refuses. Returns the chosen asset id.
 */
export async function selectFirstSelectableItem(page: Page, name?: string): Promise<string> {
  if (name !== undefined) {
    const chosen = page.getByRole("switch", { name });
    await chosen.click();
    await expect(chosen).toHaveAttribute("aria-checked", "true");
    return name;
  }
  const enabled = () =>
    page.locator('[data-card-id]:visible [role="switch"]:not([aria-disabled="true"])');
  const scopes = page.locator("aside button[aria-pressed]:visible");
  const scopeCount = await scopes.count();
  let refusal = "no catalog scope offered a selectable item";
  let tried = 0;
  for (let scope = 0; scope < scopeCount && tried < 12; scope += 1) {
    if (scope > 0) await scopes.nth(scope).click();
    const available = await enabled().count();
    for (let index = 0; index < available && tried < 12; index += 1) {
      tried += 1;
      const candidate = enabled().nth(index);
      const assetId = await candidate.evaluate(
        (node) => node.closest("[data-card-id]")?.getAttribute("data-card-id") ?? "",
      );
      await candidate.click();
      await expect(candidate).toHaveAttribute("aria-checked", "true");
      const blocked = await checkPolicy(page);
      // The managed MCP projection blocker is not a reason to pass an item
      // over: the review flyout offers the opt-in that clears it.
      if (blocked === "" || blocked === MANAGED_MCP_BLOCKER) return assetId;
      refusal = blocked;
      await candidate.click();
      await expect(candidate).toHaveAttribute("aria-checked", "false");
    }
  }
  throw new Error(`No catalog item could be selected and checked: ${refusal}`);
}

export interface DownloadedFile {
  readonly name: string;
  readonly text: string;
  readonly bytes: Buffer;
}

async function collect(
  page: Page,
  action: () => Promise<void>,
  outputPath: string,
): Promise<DownloadedFile> {
  const event = page.waitForEvent("download");
  await action();
  const download = await event;
  await download.saveAs(outputPath);
  const bytes = await readFile(outputPath);
  return { name: download.suggestedFilename(), text: bytes.toString("utf8"), bytes };
}

/** J1 last step: the review flyout writes the organization policy. */
export async function downloadOrgPolicy(page: Page, outputPath: string): Promise<DownloadedFile> {
  await page.getByRole("button", { name: "Review Changes" }).click();
  const review = page.getByRole("dialog", { name: "Review changes" });
  // A selection that reaches a Core MCP control needs the managed MCP
  // projection opt-in before the policy may be written; the flyout says so.
  // The flyout's alert carries `empty:hidden`, so with nothing to say it is
  // not in the accessibility tree: count first, never wait for it.
  const alert = review.getByRole("alert");
  const said = (await alert.count()) === 0 ? "" : ((await alert.first().textContent()) ?? "");
  if (said.includes(MANAGED_MCP_BLOCKER)) {
    const optIn = review.getByRole("switch", { name: MANAGED_MCP_SWITCH });
    await optIn.click();
    await expect(optIn).toHaveAttribute("aria-checked", "true");
    await expect(review.getByRole("alert")).toHaveCount(0);
  }
  const file = await collect(
    page,
    () => review.getByRole("button", { name: "Download" }).click(),
    outputPath,
  );
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  return file;
}

export async function goToUserPage(page: Page): Promise<void> {
  await page.getByRole("link", { name: "User page" }).click();
  await expect(page.getByRole("link", { name: "Admin page" })).toBeVisible();
}

/** The web host's J2 input: the organization policy through the file picker. */
export async function importOrgPolicy(page: Page, text: string, filePath: string): Promise<void> {
  await writeFile(filePath, text);
  await page.getByLabel("Import organization policy").setInputFiles(filePath);
  await expect(page.getByRole("status").first()).toContainText("Imported");
}

/** J2: trim, name the project, choose an AI tool, check, save. */
export async function saveProjectPolicy(
  page: Page,
  options: { item?: string; projectName: string; aiTool?: string; outputPath: string },
): Promise<DownloadedFile> {
  const card =
    options.item === undefined
      ? page.locator("[data-card-id]:visible").first()
      : page.locator(`[data-card-id="${options.item}"]:visible`);
  await card.getByText("Required", { exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(options.projectName);
  await expect(page.getByRole("radio", { name: "Project" })).toBeChecked();
  const tool =
    options.aiTool === undefined
      ? page.getByRole("checkbox").first()
      : page.getByRole("checkbox", { name: options.aiTool });
  await tool.check();
  await page.getByRole("button", { name: "Check Selection" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "The selection narrows the organization policy.",
  );
  return collect(
    page,
    () => page.getByRole("button", { name: "Save aih-project-policy.json" }).click(),
    options.outputPath,
  );
}
