import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { AIH_CAPABILITIES_FILE, capabilityResolveCommand } from "../capability/index.js";
import { AIH_CONFIG_FILE, AihConfigSchema } from "../config/marker.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";
import type { Action, PlanContext } from "../internals/plan.js";
import { digest, writeJson } from "../internals/plan.js";
import { jsonFile, lines } from "../internals/render.js";
import { type RepoStack, scanRepo } from "../profile/scan.js";

export const INIT_V3_FINGERPRINT_FILE = ".aih/fingerprint.json";

type CommittedState = "missing" | "present";

export interface InitV3Gap {
  id: string;
  severity: "warn" | "fail";
  reason: string;
  evidence: string[];
}

export interface InitV3StackSummary {
  languages: string[];
  frameworks: string[];
  cloud: string[];
  databases: string[];
  deployment: string[];
  entryPoints: string[];
  commands: {
    test?: string;
    build?: string;
    lint?: string;
    verify?: string;
    typecheck?: string;
  };
  packageManager?: string;
  isMonorepo: boolean;
  workspaceTool?: string;
  workspaceCount?: number;
}

export interface InitV3ScanReport {
  stack: InitV3StackSummary;
  existingAiConfigs: string[];
  committed: {
    aihConfig: CommittedState;
    capabilityManifest: CommittedState;
  };
  derived: {
    fingerprint: CommittedState;
  };
}

export interface InitV3Fingerprint {
  schemaVersion: 1;
  kind: "init-v3";
  contextDir: string;
  targets: string[];
  stack: InitV3StackSummary;
  plannedCapabilities: Array<{ name: string; install: string }>;
  fingerprintSha256: string;
}

export interface InitV3Report {
  schemaVersion: 1;
  scan: InitV3ScanReport;
  gaps: InitV3Gap[];
  plan: { decisions: Array<{ name: string; install: string; reason: string }> };
  fingerprint: InitV3Fingerprint;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fileState(root: string, rel: string): CommittedState {
  try {
    const info = lstatSync(join(root, rel));
    return info.isFile() ? "present" : "missing";
  } catch {
    return "missing";
  }
}

function validateCommittedAihConfig(root: string): CommittedState {
  const path = join(root, AIH_CONFIG_FILE);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw new AihError(`${AIH_CONFIG_FILE} cannot be inspected as a root file`, "AIH_CONFIG");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AihError(
      `${AIH_CONFIG_FILE} must be a regular root file, not a symlink or directory`,
      "AIH_CONFIG",
    );
  }
  const raw = readRegularFile(path)?.toString("utf8");
  if (raw === undefined) {
    throw new AihError(`${AIH_CONFIG_FILE} cannot be read as a regular file`, "AIH_CONFIG");
  }
  try {
    AihConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new AihError(
      `${AIH_CONFIG_FILE} contains entries aih cannot parse — fix it by hand first`,
      "AIH_CONFIG",
    );
  }
  return "present";
}

function stackSummary(stack: RepoStack): InitV3StackSummary {
  return {
    languages: [...stack.languages].sort(byCodeUnit),
    frameworks: [...stack.frameworks].sort(byCodeUnit),
    cloud: [...stack.cloud].sort(byCodeUnit),
    databases: [...stack.databases].sort(byCodeUnit),
    deployment: [...stack.deployment].sort(byCodeUnit),
    entryPoints: [...stack.entryPoints].sort(byCodeUnit),
    commands: {
      ...(stack.testRunner ? { test: stack.testRunner } : {}),
      ...(stack.buildCommand ? { build: stack.buildCommand } : {}),
      ...(stack.lintCommand ? { lint: stack.lintCommand } : {}),
      ...(stack.verifyCommand ? { verify: stack.verifyCommand } : {}),
      ...(stack.typecheckCommand ? { typecheck: stack.typecheckCommand } : {}),
    },
    ...(stack.packageManager ? { packageManager: stack.packageManager } : {}),
    isMonorepo: stack.isMonorepo,
    ...(stack.workspaceTool ? { workspaceTool: stack.workspaceTool } : {}),
    ...(stack.workspaceCount !== undefined ? { workspaceCount: stack.workspaceCount } : {}),
  };
}

function existingAiConfigs(root: string, contextDir: string): string[] {
  return [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".mcp.json",
    ".aih-config.json",
    AIH_CAPABILITIES_FILE,
    ".claude/settings.json",
    ".claude/managed-settings.json",
    ".cursor/rules/00-canon.mdc",
    ".kiro/steering/00-canon.md",
    `${contextDir}/RULE_ROUTER.md`,
  ]
    .filter((rel) => fileState(root, rel) === "present")
    .sort(byCodeUnit);
}

function scanInitV3(ctx: PlanContext, stack: RepoStack): InitV3ScanReport {
  return {
    stack: stackSummary(stack),
    existingAiConfigs: existingAiConfigs(ctx.root, ctx.contextDir),
    committed: {
      aihConfig: validateCommittedAihConfig(ctx.root),
      capabilityManifest: fileState(ctx.root, AIH_CAPABILITIES_FILE),
    },
    derived: {
      fingerprint: fileState(ctx.root, INIT_V3_FINGERPRINT_FILE),
    },
  };
}

function gapsFor(scan: InitV3ScanReport, contextDir: string): InitV3Gap[] {
  const gaps: InitV3Gap[] = [];
  if (scan.committed.aihConfig === "missing") {
    gaps.push({
      id: "missing-bootstrap-intent",
      severity: "warn",
      reason: `${AIH_CONFIG_FILE} is absent, so init-v3 will persist the resolved context dir and CLI targets`,
      evidence: [AIH_CONFIG_FILE],
    });
  }
  if (!scan.existingAiConfigs.includes(`${contextDir}/RULE_ROUTER.md`)) {
    gaps.push({
      id: "missing-canon-router",
      severity: "warn",
      reason: "the committed AI canon router is absent and will be produced by the init phases",
      evidence: [`${contextDir}/RULE_ROUTER.md`],
    });
  }
  if (scan.committed.capabilityManifest === "missing") {
    gaps.push({
      id: "missing-capability-intent",
      severity: "warn",
      reason: `${AIH_CAPABILITIES_FILE} is absent, so init-v3 will persist capability requirements`,
      evidence: [AIH_CAPABILITIES_FILE],
    });
  }
  if (scan.derived.fingerprint === "missing") {
    gaps.push({
      id: "missing-derived-fingerprint",
      severity: "warn",
      reason: `${INIT_V3_FINGERPRINT_FILE} is derived runtime state and will be rebuilt`,
      evidence: [INIT_V3_FINGERPRINT_FILE],
    });
  }
  return gaps.sort((a, b) => byCodeUnit(a.id, b.id));
}

function capabilityDecisions(actions: readonly Action[]): InitV3Report["plan"]["decisions"] {
  const capabilityDigest = actions.find(
    (action) => action.kind === "digest" && action.describe === "capability resolve",
  );
  const data =
    capabilityDigest?.kind === "digest" &&
    typeof capabilityDigest.data === "object" &&
    capabilityDigest.data !== null &&
    "decisions" in capabilityDigest.data
      ? (
          capabilityDigest.data as {
            decisions?: Array<{ name: string; install: string; reason: string }>;
          }
        ).decisions
      : undefined;
  return (data ?? [])
    .map((decision) => ({
      name: decision.name,
      install: decision.install,
      reason: decision.reason,
    }))
    .sort((a, b) => byCodeUnit(a.name, b.name));
}

function buildFingerprint(
  ctx: PlanContext,
  stack: InitV3StackSummary,
  decisions: InitV3Report["plan"]["decisions"],
): InitV3Fingerprint {
  const plannedCapabilities = decisions
    .map((decision) => ({ name: decision.name, install: decision.install }))
    .sort((a, b) => byCodeUnit(`${a.name}:${a.install}`, `${b.name}:${b.install}`));
  const body = {
    schemaVersion: 1 as const,
    kind: "init-v3" as const,
    contextDir: ctx.contextDir,
    targets: [...(ctx.targets ?? [])].sort(byCodeUnit),
    stack,
    plannedCapabilities,
  };
  return {
    ...body,
    fingerprintSha256: sha256Hex(jsonFile(body)),
  };
}

function reportText(report: InitV3Report): string {
  return lines(
    `stack: ${report.scan.stack.languages.join(", ") || "unknown"}`,
    `gaps: ${report.gaps.length === 0 ? "none" : report.gaps.map((gap) => gap.id).join(", ")}`,
    `planned capabilities: ${
      report.plan.decisions.length === 0
        ? "none"
        : report.plan.decisions
            .map((decision) => `${decision.name} [${decision.install}]`)
            .join(", ")
    }`,
    `fingerprint: ${INIT_V3_FINGERPRINT_FILE} (${report.fingerprint.fingerprintSha256})`,
  );
}

export async function initV3Actions(ctx: PlanContext): Promise<Action[]> {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const scan = scanInitV3(ctx, stack);
  const gaps = gapsFor(scan, ctx.contextDir);
  const capabilityPlan = await capabilityResolveCommand.plan(ctx);
  const decisions = capabilityDecisions(capabilityPlan.actions);
  const fingerprint = buildFingerprint(ctx, scan.stack, decisions);
  const report: InitV3Report = {
    schemaVersion: 1,
    scan,
    gaps,
    plan: { decisions },
    fingerprint,
  };
  return [
    digest("init v3 bootstrap intelligence", reportText(report), report),
    ...capabilityPlan.actions,
    writeJson(INIT_V3_FINGERPRINT_FILE, fingerprint, "write derived init-v3 drift fingerprint"),
  ];
}
