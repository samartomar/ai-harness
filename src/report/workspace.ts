import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { workspaceGitignoreMissing } from "../workspace/git.js";
import {
  readWorkspaceManifest,
  type WorkspaceEdge,
  type WorkspaceEvidenceStatus,
  type WorkspaceManifest,
  type WorkspaceRepo,
  workspaceManifestExists,
} from "../workspace/manifest.js";
import {
  latestWorkspaceSnapshotPath,
  readWorkspaceRepoState,
  type WorkspaceRepoState,
} from "../workspace/state.js";

const FRESH_DAYS = 7;

export interface WorkspaceEvidenceCell {
  status: WorkspaceEvidenceStatus;
  detail?: string;
}

export interface WorkspaceChildReportRow {
  id: string;
  path: string;
  kind?: string;
  router: string;
  exists: boolean;
  git: WorkspaceEvidenceCell & Partial<WorkspaceRepoState>;
  canon: WorkspaceEvidenceCell;
  config: WorkspaceEvidenceCell;
  parentIgnored: WorkspaceEvidenceCell;
  history: WorkspaceEvidenceCell & { latestSample?: string; ageDays?: number };
  usage: WorkspaceEvidenceCell & { events?: number };
  report: WorkspaceEvidenceCell & { path?: string; ageDays?: number };
  drift: { count?: number };
  status: WorkspaceEvidenceStatus;
}

export interface WorkspaceContractReportRow {
  id: string;
  from: string;
  to: string;
  kind: string;
  contractPath?: string;
  consumerPath?: string;
  status: WorkspaceEvidenceStatus;
  detail: string;
}

export interface WorkspaceSnapshotChange {
  id: string;
  path: string;
  status: "UNCHANGED" | "CHANGED" | "DIRTY" | "MISSING" | "UNKNOWN";
  before?: string;
  after?: string;
  detail: string;
}

export interface WorkspaceReportDigest {
  manifest: {
    status: WorkspaceManifest["status"];
    errors: string[];
    repos: number;
    edges: number;
    git: boolean;
    contextDir: string;
  };
  rows: WorkspaceChildReportRow[];
  contracts: WorkspaceContractReportRow[];
  snapshot?: {
    source: string;
    label?: string;
    createdAt?: string;
    changes: WorkspaceSnapshotChange[];
  };
  mcp: WorkspaceEvidenceCell & { packageSpec?: string };
  summary: Record<WorkspaceEvidenceStatus, number>;
}

export { workspaceManifestExists };

function daysSince(iso: string): number | undefined {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

function newestReport(root: string, repo: WorkspaceRepo): { path?: string; ageDays?: number } {
  const dir = join(root, repo.path, ".aih", "reports");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => /\.(html|md|json)$/i.test(name))
      .sort();
  } catch {
    return {};
  }
  let chosen: { name: string; mtimeMs: number } | undefined;
  for (const name of files) {
    try {
      const mtimeMs = statSync(join(dir, name)).mtimeMs;
      if (!chosen || mtimeMs > chosen.mtimeMs) chosen = { name, mtimeMs };
    } catch {
      // Ignore a file that disappeared during the read.
    }
  }
  if (!chosen) return {};
  return {
    path: `${repo.path}/.aih/reports/${chosen.name}`,
    ageDays: Math.max(0, Math.floor((Date.now() - chosen.mtimeMs) / 86_400_000)),
  };
}

function latestHistory(
  root: string,
  repo: WorkspaceRepo,
): { raw?: Record<string, unknown>; ts?: string } {
  const text = readIfExists(join(root, repo.path, ".aih", "history.jsonl"));
  if (text === undefined) return {};
  let latest: Record<string, unknown> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      latest = JSON.parse(t) as Record<string, unknown>;
    } catch {
      return { raw: undefined };
    }
  }
  const maybeTs = latest?.ts ?? latest?.timestamp ?? latest?.createdAt;
  return { raw: latest, ...(typeof maybeTs === "string" ? { ts: maybeTs } : {}) };
}

function lineCount(text: string | undefined): number {
  if (text === undefined) return 0;
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function workspaceMcpStatus(root: string): WorkspaceReportDigest["mcp"] {
  const text = readIfExists(join(root, ".mcp.json"));
  if (text === undefined) return { status: "UNKNOWN", detail: "no parent .mcp.json" };
  try {
    const parsed = JSON.parse(text) as {
      mcpServers?: { filesystem?: { args?: unknown } };
    };
    const args = parsed.mcpServers?.filesystem?.args;
    if (!Array.isArray(args)) {
      return { status: "UNKNOWN", detail: "workspace filesystem MCP server not configured" };
    }
    const packageSpec = args.find(
      (arg): arg is string =>
        typeof arg === "string" && arg.startsWith("@modelcontextprotocol/server-filesystem"),
    );
    if (!packageSpec) {
      return { status: "UNKNOWN", detail: "workspace filesystem MCP package not found" };
    }
    const base = "@modelcontextprotocol/server-filesystem";
    if (packageSpec === base) {
      return {
        status: "WARN",
        packageSpec,
        detail:
          "Workspace MCP filesystem server is unpinned. Set AIH_MCP_FS_VERSION or enforce a managed MCP policy.",
      };
    }
    return packageSpec.startsWith(`${base}@`)
      ? { status: "OK", packageSpec, detail: "workspace filesystem MCP package is pinned" }
      : { status: "UNKNOWN", packageSpec, detail: "workspace filesystem MCP package is unknown" };
  } catch {
    return { status: "ERROR", detail: "parent .mcp.json is malformed" };
  }
}

function readConfigStatus(
  root: string,
  repo: WorkspaceRepo,
  manifest: WorkspaceManifest,
): WorkspaceEvidenceCell {
  const text = readIfExists(join(root, repo.path, ".aih-config.json"));
  if (text === undefined) return { status: "MISSING", detail: "no child .aih-config.json" };
  try {
    const parsed = JSON.parse(text) as { contextDir?: unknown };
    const childContext = parsed.contextDir;
    if (typeof childContext === "string" && childContext !== manifest.contextDir) {
      return {
        status: "WARN",
        detail: `child contextDir ${childContext} differs from workspace ${manifest.contextDir}`,
      };
    }
    return { status: "OK" };
  } catch {
    return { status: "ERROR", detail: "child .aih-config.json is malformed" };
  }
}

function aggregateStatus(row: WorkspaceChildReportRow): WorkspaceEvidenceStatus {
  if (!row.exists) return "MISSING";
  if (row.canon.status === "NOT_ONBOARDED") return "NOT_ONBOARDED";
  if (
    [
      row.git.status,
      row.canon.status,
      row.config.status,
      row.parentIgnored.status,
      row.history.status,
      row.report.status,
    ].includes("ERROR")
  ) {
    return "ERROR";
  }
  if (row.history.status === "STALE" || row.report.status === "STALE") return "STALE";
  if (
    row.git.status !== "OK" ||
    row.config.status === "WARN" ||
    row.parentIgnored.status === "WARN" ||
    row.history.status === "NOT_COLLECTED" ||
    row.usage.status === "NOT_COLLECTED" ||
    row.report.status === "NOT_COLLECTED"
  ) {
    return "WARN";
  }
  return "OK";
}

async function childRow(
  ctx: PlanContext,
  manifest: WorkspaceManifest,
  repo: WorkspaceRepo,
  missingIgnores: readonly string[],
): Promise<WorkspaceChildReportRow> {
  const abs = join(ctx.root, repo.path);
  const exists = existsSync(abs);
  const gitState = exists ? await readWorkspaceRepoState(ctx, repo) : undefined;
  const git: WorkspaceChildReportRow["git"] =
    gitState?.git === true
      ? { status: "OK", ...gitState }
      : {
          status: exists ? "MISSING" : "MISSING",
          detail: exists ? "not a git repo" : "path missing",
        };
  const routerAbs = join(ctx.root, repo.path, repo.router);
  const canon: WorkspaceEvidenceCell = existsSync(routerAbs)
    ? { status: "OK" }
    : { status: "NOT_ONBOARDED", detail: `${repo.path}/${repo.router} missing` };
  const config = exists
    ? readConfigStatus(ctx.root, repo, manifest)
    : { status: "MISSING" as const };
  const parentIgnored: WorkspaceEvidenceCell =
    manifest.git && missingIgnores.includes(repo.path)
      ? { status: "WARN", detail: "parent git does not ignore child repo path" }
      : { status: "OK" };
  const historyPath = join(ctx.root, repo.path, ".aih", "history.jsonl");
  const historyText = readIfExists(historyPath);
  const latest = historyText === undefined ? {} : latestHistory(ctx.root, repo);
  const ageDays = latest.ts ? daysSince(latest.ts) : undefined;
  const history: WorkspaceChildReportRow["history"] =
    historyText === undefined
      ? { status: "NOT_COLLECTED", detail: "no .aih/history.jsonl" }
      : latest.raw === undefined
        ? { status: "UNKNOWN", detail: "history has no parseable samples" }
        : ageDays !== undefined && ageDays > FRESH_DAYS
          ? { status: "STALE", latestSample: latest.ts, ageDays }
          : {
              status: "OK",
              ...(latest.ts ? { latestSample: latest.ts } : {}),
              ...(ageDays !== undefined ? { ageDays } : {}),
            };
  const usageText = readIfExists(join(ctx.root, repo.path, ".aih", "usage.jsonl"));
  const usageEvents = lineCount(usageText);
  const usage: WorkspaceChildReportRow["usage"] =
    usageText === undefined
      ? { status: "NOT_COLLECTED", detail: "no .aih/usage.jsonl" }
      : { status: "OK", events: usageEvents };
  const reportInfo = newestReport(ctx.root, repo);
  const report: WorkspaceChildReportRow["report"] =
    reportInfo.path === undefined
      ? { status: "NOT_COLLECTED", detail: "no child .aih/reports artifact" }
      : reportInfo.ageDays !== undefined && reportInfo.ageDays > FRESH_DAYS
        ? { status: "STALE", ...reportInfo }
        : { status: "OK", ...reportInfo };
  const driftCount = typeof latest.raw?.driftCount === "number" ? latest.raw.driftCount : undefined;
  const row: WorkspaceChildReportRow = {
    id: repo.id,
    path: repo.path,
    ...(repo.kind ? { kind: repo.kind } : {}),
    router: repo.router,
    exists,
    git,
    canon,
    config,
    parentIgnored,
    history,
    usage,
    report,
    drift: { ...(driftCount !== undefined ? { count: driftCount } : {}) },
    status: "UNKNOWN",
  };
  return { ...row, status: aggregateStatus(row) };
}

function contractStatus(root: string, edge: WorkspaceEdge): WorkspaceContractReportRow {
  if (!edge.contractPath) {
    return { ...edge, status: "UNKNOWN", detail: "no contractPath declared" };
  }
  const contractExists = existsSync(join(root, edge.contractPath));
  const consumerExists = edge.consumerPath ? existsSync(join(root, edge.consumerPath)) : true;
  const status: WorkspaceEvidenceStatus = !contractExists
    ? edge.consumerPath && consumerExists
      ? "PARTIAL"
      : "MISSING"
    : consumerExists
      ? "OK"
      : "PARTIAL";
  const detail =
    status === "OK"
      ? "declared contract evidence exists"
      : [
          contractExists ? undefined : `missing ${edge.contractPath}`,
          edge.consumerPath && !consumerExists ? `missing ${edge.consumerPath}` : undefined,
        ]
          .filter((v): v is string => v !== undefined)
          .join("; ");
  return { ...edge, status, detail };
}

function summary(
  rows: readonly WorkspaceChildReportRow[],
): Record<WorkspaceEvidenceStatus, number> {
  const out = {
    OK: 0,
    WARN: 0,
    MISSING: 0,
    STALE: 0,
    NOT_ONBOARDED: 0,
    NOT_COLLECTED: 0,
    PARTIAL: 0,
    UNKNOWN: 0,
    ERROR: 0,
  };
  for (const row of rows) out[row.status]++;
  return out;
}

interface SnapshotFile {
  createdAt?: string;
  label?: string;
  repos?: Array<{ id?: string; path?: string; branch?: string; sha?: string; dirty?: boolean }>;
}

function readSnapshot(path: string): SnapshotFile | undefined {
  const text = readIfExists(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as SnapshotFile;
  } catch {
    return undefined;
  }
}

function snapshotTime(snapshot: SnapshotFile | undefined): number {
  const ts = snapshot?.createdAt ? new Date(snapshot.createdAt).getTime() : Number.NaN;
  return Number.isFinite(ts) ? ts : 0;
}

function workspaceSnapshot(
  root: string,
  manifest: WorkspaceManifest,
  rows: readonly WorkspaceChildReportRow[],
): WorkspaceReportDigest["snapshot"] | undefined {
  const candidates = [
    latestWorkspaceSnapshotPath(root),
    join(root, manifest.contextDir, "workspace-lock.json"),
  ].filter((path): path is string => path !== undefined);
  const loaded = candidates
    .map((path) => ({ path, snapshot: readSnapshot(path) }))
    .filter(
      (entry): entry is { path: string; snapshot: SnapshotFile } => entry.snapshot !== undefined,
    )
    .sort((a, b) => snapshotTime(b.snapshot) - snapshotTime(a.snapshot));
  const baseline = loaded[0];
  if (!baseline) return undefined;
  const byId = new Map((baseline.snapshot.repos ?? []).map((repo) => [repo.id, repo]));
  const byPath = new Map((baseline.snapshot.repos ?? []).map((repo) => [repo.path, repo]));
  const changes: WorkspaceSnapshotChange[] = rows.map((row) => {
    const before = byId.get(row.id) ?? byPath.get(row.path);
    if (!before) {
      return {
        id: row.id,
        path: row.path,
        status: "UNKNOWN",
        detail: "repo not present in snapshot",
      };
    }
    if (row.git.status !== "OK") {
      return {
        id: row.id,
        path: row.path,
        status: "MISSING",
        before: before.sha,
        detail: "current repo git state unavailable",
      };
    }
    if (row.git.dirty === true) {
      return {
        id: row.id,
        path: row.path,
        status: "DIRTY",
        before: before.sha,
        after: row.git.sha,
        detail: "child repo has uncommitted changes",
      };
    }
    if (before.sha && row.git.sha && before.sha !== row.git.sha) {
      return {
        id: row.id,
        path: row.path,
        status: "CHANGED",
        before: before.sha,
        after: row.git.sha,
        detail: "child repo HEAD changed",
      };
    }
    if (before.branch && row.git.branch && before.branch !== row.git.branch) {
      return {
        id: row.id,
        path: row.path,
        status: "CHANGED",
        before: before.branch,
        after: row.git.branch,
        detail: "child repo branch changed",
      };
    }
    return {
      id: row.id,
      path: row.path,
      status: "UNCHANGED",
      before: before.sha,
      after: row.git.sha,
      detail: "matches snapshot",
    };
  });
  return {
    source: relative(root, baseline.path).replace(/\\/g, "/"),
    ...(baseline.snapshot.label ? { label: baseline.snapshot.label } : {}),
    ...(baseline.snapshot.createdAt ? { createdAt: baseline.snapshot.createdAt } : {}),
    changes,
  };
}

function renderWorkspaceText(data: WorkspaceReportDigest): string {
  if (data.manifest.status === "ERROR" && data.rows.length === 0) {
    return lines(
      "Workspace manifest could not be parsed safely.",
      "",
      ...data.manifest.errors.map((err) => `  ERROR: ${err}`),
    );
  }
  const rows = data.rows.map(
    (row) =>
      `| ${row.id} | ${row.path}/ | ${row.git.status} | ${row.canon.status} | ${row.report.status} | ${row.usage.status} | ${row.history.status} | ${row.drift.count ?? "n/a"} | ${row.history.ageDays !== undefined ? `${row.history.ageDays}d` : "n/a"} | ${row.status} |`,
  );
  const contracts =
    data.contracts.length === 0
      ? ["No explicit workspace contract edges declared."]
      : [
          "| Contract | From | To | Kind | Status | Evidence |",
          "|---|---|---|---|---|---|",
          ...data.contracts.map(
            (edge) =>
              `| ${edge.id} | ${edge.from} | ${edge.to} | ${edge.kind} | ${edge.status} | ${edge.detail} |`,
          ),
        ];
  const snapshot = data.snapshot
    ? [
        "## Changed since snapshot",
        "",
        `Source: ${data.snapshot.source}${data.snapshot.label ? ` (${data.snapshot.label})` : ""}`,
        "",
        "| Repo | Status | Before | After | Detail |",
        "|---|---|---|---|---|",
        ...data.snapshot.changes.map(
          (change) =>
            `| ${change.id} | ${change.status} | ${change.before ?? "n/a"} | ${change.after ?? "n/a"} | ${change.detail} |`,
        ),
        "",
      ]
    : [];
  const mcp =
    data.mcp.status === "WARN" || data.mcp.status === "ERROR"
      ? ["## Governance", "", data.mcp.detail ?? data.mcp.status, ""]
      : [];
  return lines(
    "Local child evidence is summarized here; child repos remain the source of truth.",
    "",
    "| Repo | Path | Git | Canon | Report | Usage | Track | Drift | Last sample | Status |",
    "|---|---|---|---|---|---|---|---:|---|---|",
    rows,
    "",
    snapshot,
    "## Contracts",
    "",
    contracts,
    "",
    mcp,
  );
}

export async function workspaceReportDigest(ctx: PlanContext): Promise<DigestAction | undefined> {
  const manifest = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (!manifest) return undefined;
  const missingIgnores =
    manifest.git === true
      ? workspaceGitignoreMissing(
          manifest.repos.map((repo) => repo.path),
          readIfExists(join(ctx.root, ".gitignore")),
        )
      : [];
  const rows: WorkspaceChildReportRow[] = [];
  for (const repo of manifest.repos) rows.push(await childRow(ctx, manifest, repo, missingIgnores));
  const contracts = manifest.edges.map((edge) => contractStatus(ctx.root, edge));
  const mcp = workspaceMcpStatus(ctx.root);
  const snapshot = workspaceSnapshot(ctx.root, manifest, rows);
  const data: WorkspaceReportDigest = {
    manifest: {
      status: manifest.status,
      errors: manifest.errors,
      repos: manifest.repos.length,
      edges: manifest.edges.length,
      git: manifest.git,
      contextDir: manifest.contextDir,
    },
    rows,
    contracts,
    ...(snapshot ? { snapshot } : {}),
    mcp,
    summary: summary(rows),
  };
  const status =
    manifest.status === "ERROR"
      ? "ERROR"
      : rows.some((row) => row.status !== "OK") ||
          contracts.some((edge) => edge.status !== "OK") ||
          mcp.status === "WARN" ||
          mcp.status === "ERROR"
        ? "WARN"
        : "OK";
  return digest(
    `Workspace rollup — ${rows.length} repos · ${status}`,
    renderWorkspaceText(data),
    data,
  );
}
