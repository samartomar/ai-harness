import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { BaselineAuthorization } from "../baseline-evidence/verify.js";
import { AihError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import {
  type Action,
  digest,
  doc,
  type ExecAction,
  exec,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { execArgv } from "../tools/install.js";
import {
  type CodexScopedMcpServers,
  codexMcpCollisionActions,
  coreOwnedEccCodexMcpServers,
} from "./codex.js";
import type { EccComponentSelection } from "./components.js";
import { authorizedEccSelection, installedEccComponentRegistrations } from "./evidence.js";
import { codexEccActions, type EccRepoCheckout, kiroEccActions } from "./index.js";
import { eccActionsForCli, eccToolsDoc, isAihDirectEccInstallTarget } from "./install.js";
import { eccMaterializationSpec } from "./materialize.js";
import { scopedEccMcpJsonActions, selectedEccMcpServers } from "./mcp.js";
import {
  mergeRegistrationLedger,
  type ProjectRegistration,
  type RegistrationLedger,
  serializeRegistrationLedger,
} from "./registration.js";
import type { EccLanguagePack } from "./select.js";

export interface VerifiedEccRequest {
  clis: Cli[];
  profile: string;
  packs: EccLanguagePack[];
  stackSummary?: string;
  selection?: EccComponentSelection;
  /** Governance makes the verified materializer exclude AIH-owned MCP/hooks. */
  governance?: true;
  project?: ProjectRegistration;
  ledger?: RegistrationLedger;
}

interface VerifiedInstallStep {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Stdin payload for the step. Unbounded data (ledger, materialization
   * payloads) must NEVER ride argv — Windows command lines cap at 32,767
   * chars, and the W4 live run hit ENAMETOOLONG once the registration ledger
   * grew (defect: nested base64 payloads scaling with ledger size). */
  input?: string;
}

const VERIFIED_ECC_INSTALL_DRIVER = String.raw`
const child = require("node:child_process");
const fs = require("node:fs");
const stepsPath = process.argv[1];
const steps = JSON.parse(fs.readFileSync(stepsPath, "utf8"));
try {
  fs.unlinkSync(stepsPath);
  fs.rmdirSync(require("node:path").dirname(stepsPath));
} catch (_) {}
for (const step of steps) {
  if (!step || !Array.isArray(step.argv) || typeof step.cwd !== "string" || step.argv.length === 0) {
    process.stderr.write("invalid verified ECC install step\n");
    process.exit(1);
  }
  const options = {
    cwd: step.cwd,
    env: { ...process.env, ...(step.env || {}) },
    shell: false,
  };
  if (typeof step.input === "string") {
    options.input = step.input;
    options.stdio = ["pipe", "inherit", "inherit"];
  } else {
    options.stdio = "inherit";
  }
  const result = child.spawnSync(step.argv[0], step.argv.slice(1), options);
  if (result.error) {
    process.stderr.write(result.error.message + "\n");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
`;

const VERIFIED_ECC_MATERIALIZE_DRIVER = String.raw`
const path = require("node:path");
const payload = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (!payload || typeof payload.sourceRoot !== "string" || typeof payload.target !== "string" || typeof payload.homeDir !== "string" || typeof payload.projectRoot !== "string" || !payload.spec) {
  throw new Error("invalid scoped ECC materialization payload");
}
const { createManifestInstallPlan, applyInstallPlan } = require(path.join(payload.sourceRoot, "scripts", "lib", "install-executor.js"));
const spec = payload.spec;
const plan = createManifestInstallPlan({
  sourceRoot: payload.sourceRoot,
  target: payload.target,
  profileId: spec.scope === "full" ? "full" : null,
  moduleIds: spec.scope === "full" ? [] : spec.moduleIds,
  homeDir: payload.homeDir,
  projectRoot: payload.projectRoot,
});
if (spec.excludeAihOwnedSurfaces === true) {
  const expectedInstallStatePath = {
    claude: path.join(payload.homeDir, ".claude", "ecc", "install-state.json"),
    cursor: path.join(payload.projectRoot, ".cursor", "ecc-install-state.json"),
    gemini: path.join(payload.projectRoot, ".gemini", "ecc-install-state.json"),
    opencode: path.join(payload.homeDir, ".opencode", "ecc-install-state.json"),
    zed: path.join(payload.projectRoot, ".zed", "ecc-install-state.json"),
  }[payload.target];
  if (!expectedInstallStatePath || typeof plan.installStatePath !== "string" || path.resolve(plan.installStatePath) !== path.resolve(expectedInstallStatePath)) {
    throw new Error("ECC install-state path is not the exact authorized target state path");
  }
  // Do not leave an upstream-provided alias in the object consumed by apply:
  // the expected path is both authority and the eventual write destination.
  plan.installStatePath = expectedInstallStatePath;
}
const normalize = (value) => String(value || "").replace(/\\/g, "/");
const identity = (operation) => [operation.kind, operation.moduleId, normalize(operation.sourceRelativePath), normalize(operation.destinationPath)].join("\0");
if (!Array.isArray(plan.operations) || !plan.statePreview || !Array.isArray(plan.statePreview.operations)) throw new Error("invalid ECC manifest plan operation arrays");
if (plan.operations.length !== plan.statePreview.operations.length || plan.operations.some((operation, index) => identity(operation) !== identity(plan.statePreview.operations[index]))) throw new Error("ECC manifest operation/state preview drift");
for (const operation of plan.operations) {
  if (operation.kind !== "copy-file" && operation.kind !== "merge-json") throw new Error("unsupported ECC manifest operation kind: " + operation.kind);
}
const selectOperation = (operation) => {
  if (spec.scope === "full") return true;
  const wholeModules = new Set(spec.wholeModules);
  const skills = new Set(spec.skills);
  const agents = new Set(spec.agents);
  const sourceRoots = new Set(spec.sourceRoots || []);
  if (wholeModules.has(operation.moduleId)) return true;
  const source = normalize(operation.sourceRelativePath);
  for (const sourceRoot of sourceRoots) {
    const root = normalize(sourceRoot);
    if (source === root || source.startsWith(root + "/")) return true;
  }
  if (spec.agentScaffolding && (source === "AGENTS.md" || source === ".agents/plugins/marketplace.json")) return true;
  const agent = /^agents\/([^/]+)\.md$/.exec(source);
  if (agent && agents.has(agent[1])) return true;
  const skill = /^(?:skills|\.agents\/skills)\/([^/]+)\//.exec(source);
  return Boolean(skill && skills.has(skill[1]));
};
let operations = plan.operations.filter(selectOperation);
if (spec.excludeAihOwnedSurfaces === true) {
  const assertSourcePath = (value) => {
    const normalized = normalize(value);
    if (!normalized || normalized.includes(String.fromCharCode(0)) || normalized.startsWith("/") || normalized.startsWith("//") || /^[a-z]:\//i.test(normalized) || normalized.startsWith("./") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("unsafe ECC source path: " + value);
    }
    return normalized;
  };
  const assertDestinationPath = (value) => {
    const normalized = normalize(value);
    const windowsAbsolute = /^[a-z]:\//i.test(normalized);
    const posixAbsolute = normalized.startsWith("/") && !normalized.startsWith("//");
    const body = windowsAbsolute ? normalized.slice(3) : posixAbsolute ? normalized.slice(1) : "";
    if (!normalized || normalized.includes(String.fromCharCode(0)) || (!windowsAbsolute && !posixAbsolute) || !body || body.startsWith("./") || body.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("unsafe ECC destination path: " + value);
    }
    if (containedRelative(payload.projectRoot, normalized) === undefined && containedRelative(payload.homeDir, normalized) === undefined) {
      throw new Error("ECC destination escapes authorized project/home roots: " + value);
    }
    return normalized;
  };
  const containedRelative = (root, destination) => {
    const inside = path.relative(path.resolve(root), path.resolve(destination));
    if (!inside || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || path.isAbsolute(inside)) return undefined;
    const normalized = normalize(inside);
    return normalized.split("/").some((part) => !part || part === "." || part === "..") ? undefined : normalized;
  };
  const mcpPath = (value) => /(?:^|\/)(?:\.mcp\.json|mcp\.json|mcp-servers\.json)$/i.test(value) || /^(?:mcp-configs|mcp)(?:\/|$)/i.test(value);
  const hostRuntimePath = (value) => /(?:^|\/)(?:\.claude|\.codex|\.cursor|\.kiro|\.gemini|\.opencode|\.zed)\/(?:hooks(?:\/|$)|(?:settings(?:\.local)?\.json|config\.(?:json|toml)))$/i.test(value) || /^(?:hooks|scripts\/hooks)(?:\/|$)/i.test(value);
  const eccContentPath = (value) => value === "AGENTS.md" || /^(?:\.agents\/(?:plugins|skills)\/|agents\/|skills\/|commands\/|rules\/|\.claude\/commands\/|\.codex\/AGENTS\.md$)/.test(value);
  const eccContentDestination = (source, destination) => {
    const mapping = (() => {
      if (source === "AGENTS.md") return { root: payload.projectRoot, relative: "AGENTS.md" };
      if (source === ".codex/AGENTS.md") return { root: payload.homeDir, relative: ".codex/AGENTS.md" };
      const targetRoot = payload.target === "kimi" ? ".kimi-code" : "." + payload.target;
      const mappings = [[".agents/plugins/", ".agents/plugins/"], [".agents/skills/", ".agents/skills/"], ...(payload.target === "claude" ? [[".claude/commands/", ".claude/commands/"]] : []), ...(payload.target === "opencode" ? [] : [["agents/", targetRoot + "/agents/"], ["skills/", targetRoot + "/skills/"], ["commands/", targetRoot + "/commands/"], ["rules/", targetRoot + "/rules/"]])];
      for (const [sourcePrefix, targetPrefix] of mappings) {
        if (!source.startsWith(sourcePrefix)) continue;
        const suffix = source.slice(sourcePrefix.length);
        return suffix ? { root: payload.projectRoot, relative: targetPrefix + suffix } : undefined;
      }
      return undefined;
    })();
    return Boolean(mapping) && containedRelative(mapping.root, destination) === mapping.relative;
  };
  const classify = (operation) => {
    if (operation.kind !== "copy-file" && operation.kind !== "merge-json") throw new Error("unsupported ECC manifest operation kind: " + operation.kind);
    if (typeof operation.moduleId !== "string" || operation.moduleId.trim().length === 0) throw new Error("invalid ECC manifest module identity");
    const source = assertSourcePath(operation.sourceRelativePath);
    const destination = assertDestinationPath(operation.destinationPath);
    if (mcpPath(source) || mcpPath(destination)) return "mcp";
    if (operation.moduleId === "hooks-runtime" || hostRuntimePath(source) || hostRuntimePath(destination)) return "host-runtime";
    if (operation.kind === "merge-json") throw new Error("unclassifiable governed ECC merge-json operation: " + operation.moduleId + ":" + destination);
    if (!eccContentPath(source) || !eccContentDestination(source, destination)) throw new Error("unclassifiable governed ECC content operation: " + operation.moduleId + ":" + source + " -> " + destination);
    return "ecc-content";
  };
  const destinations = new Set();
  operations = operations.filter((operation) => {
    if (classify(operation) !== "ecc-content") return false;
    const destination = normalize(operation.destinationPath);
    const collisionKey = destination.normalize("NFC").toLowerCase();
    if (destinations.has(collisionKey)) throw new Error("normalized governed ECC destination collision: " + destination);
    destinations.add(collisionKey);
    return true;
  });
}
if (operations.length !== plan.operations.length) {
  plan.operations = operations;
  plan.statePreview.operations = operations;
}
applyInstallPlan(plan);
`;

const VERIFIED_ECC_LEDGER_WRITER = `
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const transientLockCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
const retryTransient = (operation) => {
  let delayMs = 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!transientLockCodes.has(error && error.code) || attempt >= 10) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
};
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
if (!payload || typeof payload.home !== "string" || !path.isAbsolute(payload.home) || typeof payload.contents !== "string") throw new Error("invalid ECC registration-ledger payload");
const safe = (entry, kind) => {
  if (!fs.existsSync(entry)) return;
  const stats = fs.lstatSync(entry);
  if (stats.isSymbolicLink()) throw new Error("refusing symlinked ECC registration-ledger path: " + entry);
  if (kind === "directory" && !stats.isDirectory()) throw new Error("ECC registration-ledger parent is not a directory: " + entry);
  if (kind === "file" && !stats.isFile()) throw new Error("ECC registration-ledger is not a regular file: " + entry);
};
safe(payload.home, "directory");
let directory = payload.home;
for (const segment of [".aih", "ecc"]) {
  directory = path.join(directory, segment);
  safe(directory, "directory");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  safe(directory, "directory");
}
const target = path.join(directory, "registration-ledger.json");
safe(target, "file");
const temporary = path.join(directory, ".registration-ledger." + process.pid + "." + crypto.randomUUID() + ".tmp");
try {
  fs.writeFileSync(temporary, payload.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  retryTransient(() => fs.renameSync(temporary, target));
} finally {
  fs.rmSync(temporary, { force: true });
}
`;

const ECC_UPSTREAM_MCPS = [
  "chrome-devtools",
  "context7",
  "exa",
  "github",
  "memory",
  "playwright",
  "sequential-thinking",
  "supabase",
] as const;

function disabledUpstreamMcps(selection: EccComponentSelection): string {
  const enabled = new Set(
    selection.mcps
      .map((component) => component.slice("mcp:".length))
      .filter((name) => ECC_UPSTREAM_MCPS.includes(name as (typeof ECC_UPSTREAM_MCPS)[number])),
  );
  return ECC_UPSTREAM_MCPS.filter((name) => !enabled.has(name)).join(",");
}

function materializeStep(
  ctx: PlanContext,
  sourceRoot: string,
  target: Cli,
  selection: EccComponentSelection,
  spec: ReturnType<typeof eccMaterializationSpec>,
): VerifiedInstallStep {
  const homeDir = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
  const payload = {
    sourceRoot,
    target,
    homeDir,
    projectRoot: ctx.root,
    ...spec,
    spec,
  };
  return {
    argv: [process.execPath, "-e", VERIFIED_ECC_MATERIALIZE_DRIVER],
    cwd: ctx.root,
    env: { ECC_DISABLED_MCPS: disabledUpstreamMcps(selection) },
    input: JSON.stringify(payload),
  };
}

function ledgerWriteStep(ctx: PlanContext, ledger: RegistrationLedger): VerifiedInstallStep {
  const home = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
  return {
    argv: [process.execPath, "-e", VERIFIED_ECC_LEDGER_WRITER],
    cwd: ctx.root,
    input: JSON.stringify({ home, contents: serializeRegistrationLedger(ledger) }),
  };
}

function checkout(sourceRoot: string, pin: string | undefined): EccRepoCheckout {
  return {
    dir: sourceRoot,
    posix: sourceRoot.replace(/\\/g, "/"),
    explicit: true,
    hasCache: false,
    ref: pin,
  };
}

function step(action: ExecAction, fallbackCwd: string): VerifiedInstallStep {
  return { argv: [...action.argv], cwd: action.cwd ?? fallbackCwd };
}

function evidenceDigest(authorizations: readonly BaselineAuthorization[]): Action {
  const summary = authorizations.map(
    (receipt) =>
      `- ${receipt.componentId} — ${receipt.tier} · ${receipt.pinnedSha.slice(0, 12)} · ${receipt.treeSha256.slice(0, 12)}`,
  );
  return digest(
    "ECC baseline evidence authorizations",
    lines("ECC install authorized by signed component evidence:", ...summary),
    { authorizations: [...authorizations] },
  );
}

function requireAuthorizedRuntime(
  authorizations: readonly BaselineAuthorization[],
  componentId: "runtime:ecc-installer" | "runtime:ecc-kiro",
): void {
  if (!authorizations.some((authorization) => authorization.componentId === componentId)) {
    throw new AihError(`refusing unauthorized ECC runtime ${componentId}`, "AIH_TRUST");
  }
}

function driverAction(steps: readonly VerifiedInstallStep[]): Action {
  // The steps ride a temp FILE, never argv: they embed unbounded payloads
  // (registration ledger, materialization spec) and Windows command lines cap
  // at 32,767 chars (W4 live-run ENAMETOOLONG). This file drives a PRIVILEGED
  // installer, so it lands in a private per-invocation directory created with
  // `mkdtempSync` (mode 0700, atomic, unguessable) rather than a bare
  // world-writable tmp path — no symlink/pre-plant race can swap the driver's
  // instructions. The driver deletes the file as its first act.
  const stepsDir = mkdtempSync(join(tmpdir(), "aih-ecc-verified-"));
  const stepsPath = join(stepsDir, "steps.json");
  writeFileSync(stepsPath, JSON.stringify(steps), "utf8");
  return exec(
    "Install from the evidence-verified ECC checkout — sequential fail-closed driver",
    [process.execPath, "-e", VERIFIED_ECC_INSTALL_DRIVER, stepsPath],
    {
      timeoutMs: 180_000,
      failureCheck: (result) => ({
        name: "verified ECC install",
        verdict: "fail",
        detail: `verified ECC install step failed (exit ${result.code ?? "signal"})`,
      }),
    },
  );
}

export function verifiedEccInstallPlan(
  ctx: PlanContext,
  sourceRoot: string,
  request: VerifiedEccRequest,
  authorizations: readonly BaselineAuthorization[],
): Plan {
  if (request.governance === true && request.selection === undefined) {
    throw new AihError(
      "refusing governed ECC install without an authorized component selection; policy project owns AIH MCP and hook projection",
      "AIH_TRUST",
    );
  }
  const pin = authorizations[0]?.pinnedSha;
  const repo = checkout(sourceRoot, pin);
  const evidenceBoundTargets = request.clis.filter(
    (cli) => isAihDirectEccInstallTarget(cli) || cli === "codex",
  );
  const needsNodeRuntime = evidenceBoundTargets.length > 0;
  if (needsNodeRuntime) {
    requireAuthorizedRuntime(authorizations, "runtime:ecc-installer");
  }
  const selection =
    request.selection === undefined
      ? undefined
      : authorizedEccSelection(request.selection, authorizations, evidenceBoundTargets);
  const materialization =
    selection === undefined
      ? undefined
      : {
          ...eccMaterializationSpec(selection),
          ...(request.governance === true ? { excludeAihOwnedSurfaces: true } : {}),
        };
  if (
    selection !== undefined &&
    selection.scope === "scoped" &&
    evidenceBoundTargets.length > 0 &&
    selection.components.length === 0 &&
    selection.mcps.length === 0 &&
    (selection.moduleIds?.length ?? 0) === 0
  ) {
    throw new AihError(
      "refusing ECC install because no selected ECC component has authorization",
      "AIH_TRUST",
    );
  }
  const pre: Action[] = [];
  const post: Action[] = [];
  const steps: VerifiedInstallStep[] = [];
  const installedClis: Cli[] = [];
  if (needsNodeRuntime) {
    steps.push({
      argv: execArgv(ctx.host.platform, [
        "npm",
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]),
      cwd: sourceRoot,
    });
  }

  for (const cli of request.clis) {
    if (isAihDirectEccInstallTarget(cli)) {
      if (selection !== undefined && materialization !== undefined) {
        steps.push(materializeStep(ctx, sourceRoot, cli, selection, materialization));
      } else {
        steps.push({
          argv: [
            process.execPath,
            join(sourceRoot, "scripts", "install-apply.js"),
            "--target",
            cli,
            "--profile",
            request.profile,
            ...request.packs,
          ],
          cwd: ctx.root,
        });
      }
      installedClis.push(cli);
      continue;
    }
    if (cli === "codex") {
      const selectedMcps = selection === undefined ? {} : selectedEccMcpServers(selection.mcps);
      const scopedMcps: CodexScopedMcpServers =
        request.governance === true ? {} : { ...selectedMcps, ...coreOwnedEccCodexMcpServers() };
      const plannedTransports = new Map(
        Object.entries(scopedMcps).map(([name, server]) => [name, server.type] as const),
      );
      const blockers = codexMcpCollisionActions(ctx, plannedTransports);
      if (blockers.length > 0) {
        pre.push(...blockers);
        continue;
      }
      for (const action of codexEccActions(
        ctx,
        repo,
        request.profile,
        materialization,
        scopedMcps,
        request.governance === true,
      )) {
        if (action.kind === "exec") {
          if (!action.describe.includes("Node dependencies")) {
            const codexStep = step(action, sourceRoot);
            if (selection !== undefined) {
              codexStep.env = {
                ECC_DISABLED_MCPS: disabledUpstreamMcps(selection),
              };
            }
            steps.push(codexStep);
          }
        } else if (action.kind === "doc" || action.kind === "digest") post.push(action);
        else pre.push(action);
      }
      installedClis.push(cli);
      continue;
    }
    if (cli === "kiro") {
      if (selection !== undefined) {
        post.push(
          ...eccActionsForCli(cli, {
            profile: request.profile,
            stackSummary: request.stackSummary ?? "this repository",
            platform: ctx.host.platform,
            packs: request.packs,
          }),
        );
        continue;
      }
      requireAuthorizedRuntime(authorizations, "runtime:ecc-kiro");
      for (const action of kiroEccActions(ctx, repo)) {
        if (action.kind === "exec") steps.push(step(action, sourceRoot));
        else if (action.kind === "doc" || action.kind === "digest") post.push(action);
        else pre.push(action);
      }
      installedClis.push(cli);
      continue;
    }
    post.push(
      ...eccActionsForCli(cli, {
        profile: request.profile,
        stackSummary: request.stackSummary ?? "this repository",
        platform: ctx.host.platform,
        packs: request.packs,
      }),
    );
  }

  const { project, ledger: priorLedger } = request;
  if (selection !== undefined && installedClis.length > 0) {
    pre.push(...scopedEccMcpJsonActions(ctx, installedClis, selection, project));
  }
  if (
    selection !== undefined &&
    project !== undefined &&
    priorLedger !== undefined &&
    installedClis.length > 0
  ) {
    const targets = installedClis.map((target) => ({
      target,
      components: installedEccComponentRegistrations(target, selection, authorizations),
      mcps: [...selection.mcps],
    }));
    const ledger = mergeRegistrationLedger(priorLedger, project, targets);
    steps.push(ledgerWriteStep(ctx, ledger));
  }

  post.push(eccToolsDoc());

  return plan(
    "ecc: verified install",
    ...pre,
    ...(steps.length > 0 ? [driverAction(steps)] : []),
    ...post,
    doc(
      "ECC verified source",
      `Every mutating ECC step above uses ${sourceRoot.replace(/\\/g, "/")} after component hash verification.`,
    ),
    evidenceDigest(authorizations),
  );
}
