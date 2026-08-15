import { join } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { RepoStack } from "../profile/scan.js";
import { execArgv } from "../tools/install.js";
import {
  MCP_PIN_CONFIG_FILES,
  type McpPackageResolver,
  mcpLaunchLabel,
  mcpLaunchServerName,
  mcpResolverLike,
  mcpResolverPinState,
  npxLaunchPins,
  uvxPrimaryPin,
} from "./pins.js";
import { mcpServers } from "./servers.js";

/**
 * Pin currency for the wired MCP tool pins (issue #504). The catalog pins are
 * compile-time constants, so picking up an upstream improvement is a double lag
 * by construction: the pin must be bumped in an aih RELEASE, and each repo must
 * then RE-PROJECT its `.mcp.json`. This probe makes both halves visible:
 *
 *  - offline, every run: each exactly-pinned launch in `.mcp.json` is compared
 *    against the pin THIS aih build's catalog generates for the same server — a
 *    difference is the re-projection half (`mcp.projection-stale`, fixed by
 *    `aih mcp --apply`);
 *  - opt-in `aih doctor --check-pin-currency`: each pin is compared against its
 *    registry's latest release (npm via `npm view`, PyPI via its JSON metadata
 *    endpoint over curl). A newer release warns `mcp.pin-stale` — a candidate
 *    for the vet-then-bump flow, never an automatic upgrade. The query reads
 *    registry METADATA only; nothing is downloaded or executed, but it is still
 *    network egress from a read-only command, so it stays opt-in (mirroring
 *    `--attest-mcp-pins`).
 *
 * Registry responses are cross-boundary data: sanitized, bounded, and parsed
 * strictly before they are echoed into the report.
 */

/** `ctx.options` key for the `--check-pin-currency` doctor flag. */
export const CHECK_PIN_CURRENCY_OPTION = "checkPinCurrency";

const PROBE_NAME = "mcp-pin-currency";
const REGISTRY_TIMEOUT_MS = 15_000;

/**
 * An all-on repo stack for reading the catalog's pins: every stack dimension is
 * populated — the full detection vocabulary for the enumerable dimensions (the
 * WEB_FRAMEWORKS set from servers.ts, the cloud/database/deployment values
 * scan.ts documents) and representative truthy values for the rest — so
 * stack-conditional catalog servers are enabled and their pins comparable. This
 * maximizes coverage but proves nothing by itself: the catalog-pin visibility
 * guard in tests/mcp/mcp.test.ts fails the build when any exact pin declared in
 * servers.ts is missing from {@link bakedCatalogPins}, so a future conditional
 * pin this stack fails to enable breaks CI instead of silently vanishing from
 * the offline currency tier.
 */
const ALL_SERVERS_STACK: RepoStack = {
  languages: ["TypeScript/Node.js", "Python"],
  frameworks: ["Next.js", "React", "Vue", "Svelte", "Angular"],
  cloud: ["AWS", "Azure", "GCP"],
  databases: ["PostgreSQL", "MySQL", "MongoDB", "SQLite", "Redis", "DynamoDB"],
  deployment: ["Docker", "Kubernetes-Helm", "Terraform", "Serverless Framework"],
  packageManager: "npm",
  hasTypeScript: true,
  scripts: { test: "npm test" },
  description: "all-on stack for catalog pin enumeration",
  entryPoints: ["src/index.ts"],
  testRunner: "npm test",
  buildCommand: "npm run build",
  lintCommand: "npm run lint",
  formatCommand: "npm run format",
  startCommand: "npm start",
  verifyCommand: "npm run verify",
  typecheckCommand: "npm run typecheck",
  deploymentCommands: {
    cdkSynth: "npx cdk synth",
    cdkDiff: "npx cdk diff",
    cdkDeploy: "npx cdk deploy",
  },
  browserTest: true,
  isMonorepo: true,
  workspaceTool: "npm-yarn",
  workspaces: {},
  workspaceCount: 1,
  virtualEnvPaths: [".venv"],
};

interface ExactLaunchPin {
  packageName: string;
  version: string;
  spec: string;
}

interface TrackedPin extends ExactLaunchPin {
  server: string;
  resolver: McpPackageResolver;
}

interface PinnedLaunchConfig {
  server: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

type LaunchConfig =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "none" }
  | { state: "servers"; launches: PinnedLaunchConfig[] };

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function envRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Every npx/uvx-like stdio launch declared in the repo's repo-local MCP configs. */
function readResolverLaunches(root: string): LaunchConfig {
  const launches: PinnedLaunchConfig[] = [];
  let sawFile = false;
  let sawInvalid = false;
  for (const rel of MCP_PIN_CONFIG_FILES) {
    const raw = readRegularFile(join(root, rel))?.toString("utf8");
    if (raw === undefined) continue;
    sawFile = true;
    let parsed: unknown;
    try {
      parsed = parseJsoncText(raw);
    } catch {
      sawInvalid = true;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sawInvalid = true;
      continue;
    }
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === undefined) continue;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      sawInvalid = true;
      continue;
    }
    for (const [server, entry] of Object.entries(servers)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const command = typeof record.command === "string" ? record.command : "";
      if (mcpResolverLike(command) === undefined) continue;
      launches.push({
        server: mcpLaunchLabel(server, rel),
        command,
        args: stringArray(record.args),
        env: envRecord(record.env),
      });
    }
  }
  if (!sawFile) return { state: "absent" };
  // An unreadable config must never read as clean — see the same gate in attest.ts.
  if (sawInvalid) return { state: "invalid" };
  return launches.length === 0 ? { state: "none" } : { state: "servers", launches };
}

/**
 * The exact package pin behind a resolver launch, only when the whole launch
 * carries exact-pin evidence ({@link mcpResolverPinState} is the fail-closed
 * gate — the literal resolver command, exact end-to-end pins, no
 * config-supplied environment).
 */
function launchPin(launch: PinnedLaunchConfig): TrackedPin | undefined {
  if (mcpResolverPinState(launch.command, launch.args, launch.env) !== "pinned") return undefined;
  const resolver =
    launch.command === "npx" || launch.command === "uvx" ? launch.command : undefined;
  if (resolver === undefined) return undefined;
  const pin = resolver === "uvx" ? uvxPrimaryPin(launch.args) : npxLaunchPins(launch.args)[0];
  return pin === undefined ? undefined : { server: launch.server, resolver, ...pin };
}

/** The distribution name behind a pin — uvx extras (`pkg[ui]`) stripped. */
function basePackageName(packageName: string): string {
  return packageName.replace(/\[[^\]]*\]$/, "");
}

/**
 * The exact pins the CURRENT build's catalog generates, by server name, read
 * under {@link ALL_SERVERS_STACK}. Exported for the catalog-pin visibility
 * guard in tests/mcp/mcp.test.ts, which fails when any exact pin declared in
 * servers.ts is missing here — the enforcement that no catalog pin can be
 * invisible to the offline currency tier.
 */
export function bakedCatalogPins(): Map<string, ExactLaunchPin> {
  const pins = new Map<string, ExactLaunchPin>();
  for (const [server, config] of Object.entries(mcpServers("project", ALL_SERVERS_STACK))) {
    if (config.type !== "stdio") continue;
    const pin = launchPin({ server, command: config.command, args: config.args, env: config.env });
    if (pin !== undefined) pins.set(server, pin);
  }
  return pins;
}

/** Printable, bounded echo of a cross-boundary string (registry output → report). */
function sanitizeExternal(value: string): string {
  const cleaned = [...value]
    .map((ch) => (ch >= " " && ch <= "~" ? ch : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "<unprintable>";
}

/**
 * `major.minor.patch` as a numeric triple; `undefined` for anything else.
 * Prerelease/build suffixes are ignored for ordering — the currency signal is an
 * advisory about release lag, not a full semver resolver.
 */
function versionTriple(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

type LatestResult = { version: string } | { error: string };

async function npmLatest(ctx: PlanContext, packageName: string): Promise<LatestResult> {
  const res = await ctx.run(execArgv(ctx.host.platform, ["npm", "view", packageName, "version"]), {
    timeoutMs: REGISTRY_TIMEOUT_MS,
  });
  if (res.spawnError) return { error: "npm not found on PATH" };
  if (res.code !== 0) {
    return { error: sanitizeExternal(res.stderr.trim() || `npm view exited ${res.code}`) };
  }
  const first = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return { error: "registry returned no version" };
  return { version: sanitizeExternal(first) };
}

async function pypiLatest(ctx: PlanContext, packageName: string): Promise<LatestResult> {
  // The name feeds a URL: accept only the character set the pin grammar allows,
  // and refuse anything else outright (fail closed, no coercion).
  if (!/^[A-Za-z0-9._-]+$/.test(packageName)) return { error: "unsafe package name" };
  const res = await ctx.run(
    ["curl", "-fsS", "--max-time", "15", `https://pypi.org/pypi/${packageName}/json`],
    { timeoutMs: REGISTRY_TIMEOUT_MS },
  );
  if (res.spawnError)
    return { error: "curl not found on PATH (needed for the PyPI metadata query)" };
  if (res.code !== 0) {
    return { error: sanitizeExternal(res.stderr.trim() || `curl exited ${res.code}`) };
  }
  try {
    const parsed = JSON.parse(res.stdout) as { info?: { version?: unknown } };
    const version = parsed.info?.version;
    if (typeof version !== "string") return { error: "registry returned no version" };
    return { version: sanitizeExternal(version) };
  } catch {
    return { error: "registry response was not parseable JSON" };
  }
}

/**
 * The doctor probe. Verdict grammar: `pass` only when the registries were
 * actually queried (`--check-pin-currency`), every pin matches its registry's
 * latest release, and no projection lag exists. A newer upstream release is an
 * advisory `skip` coded `mcp.pin-stale`; a `.mcp.json` pin off this build's
 * catalog pin is an advisory `skip` coded `mcp.projection-stale` (reported even
 * without the flag — it needs no network). Every cannot-check state is a
 * visible uncoded `skip`, never silence and never a false green.
 */
export async function mcpPinCurrencyProbe(ctx: PlanContext): Promise<Check> {
  const name = PROBE_NAME;
  const cfg = readResolverLaunches(ctx.root);
  if (cfg.state === "absent") {
    return {
      name,
      verdict: "skip",
      detail:
        "no repo-local MCP config (.mcp.json / .kiro/settings/mcp.json) — no MCP servers configured",
    };
  }
  if (cfg.state === "invalid") {
    return {
      name,
      verdict: "skip",
      detail: "invalid .mcp.json — cannot track MCP package pin currency",
      code: "mcp.config-invalid",
    };
  }
  if (cfg.state === "none") {
    return {
      name,
      verdict: "skip",
      detail: "no npx/uvx MCP package launches in .mcp.json to track",
    };
  }

  const tracked: TrackedPin[] = [];
  const untracked: string[] = [];
  for (const launch of [...cfg.launches].sort((a, b) => a.server.localeCompare(b.server))) {
    const pin = launchPin(launch);
    if (pin === undefined) untracked.push(launch.server);
    else tracked.push(pin);
  }
  const untrackedNote =
    untracked.length > 0
      ? `; no exact end-to-end pin to track: ${untracked.join(", ")} — pin as pkg==x.y.z (or pkg@x.y.z)`
      : "";

  if (tracked.length === 0) {
    return {
      name,
      verdict: "skip",
      detail: `no exactly-pinned MCP package launches to track${untrackedNote}`,
    };
  }

  // Offline half: the repo's projected pins vs the pins THIS build would generate.
  const baked = bakedCatalogPins();
  const projectionLag: string[] = [];
  for (const pin of tracked) {
    // The launch label is config-qualified (`name @ .kiro/settings/mcp.json`) so reports
    // stay unambiguous across files, but the catalog is keyed by bare server name — a
    // qualified lookup would silently exempt every Kiro-declared catalog server from the
    // offline projection-lag comparison.
    const counterpart = baked.get(mcpLaunchServerName(pin.server));
    if (
      counterpart === undefined ||
      basePackageName(counterpart.packageName) !== basePackageName(pin.packageName) ||
      counterpart.version === pin.version
    ) {
      continue;
    }
    const configured = versionTriple(pin.version);
    const generated = versionTriple(counterpart.version);
    const direction =
      configured !== undefined && generated !== undefined
        ? compareTriples(configured, generated) < 0
          ? "behind"
          : "ahead of"
        : "off";
    projectionLag.push(
      `${pin.server}: projected pin ${pin.spec} but this aih build's catalog pins ${counterpart.spec} (${direction} the catalog) — run \`aih mcp --apply\` to re-project`,
    );
  }
  const projectionNote = projectionLag.length > 0 ? `; ${projectionLag.join("; ")}` : "";

  if (ctx.options[CHECK_PIN_CURRENCY_OPTION] !== true) {
    const list = tracked.map((pin) => `${pin.server} (${pin.spec})`).join(", ");
    const detail =
      `${tracked.length} exactly-pinned MCP package launch(es) tracked: ${list} — run ` +
      `\`aih doctor --check-pin-currency\` to compare each pin against its registry's latest ` +
      `release (registry metadata only; nothing is downloaded or executed)${projectionNote}${untrackedNote}`;
    if (projectionLag.length > 0) {
      return { name, verdict: "skip", code: "mcp.projection-stale", detail };
    }
    return { name, verdict: "skip", detail };
  }

  const stale: string[] = [];
  const current: string[] = [];
  const unresolved: string[] = [];
  for (const pin of tracked) {
    const packageName = basePackageName(pin.packageName);
    const latest =
      pin.resolver === "npx"
        ? await npmLatest(ctx, packageName)
        : await pypiLatest(ctx, packageName);
    if ("error" in latest) {
      unresolved.push(`${pin.spec} (${latest.error})`);
      continue;
    }
    const pinned = versionTriple(pin.version);
    const published = versionTriple(latest.version);
    if (pinned === undefined || published === undefined) {
      unresolved.push(`${pin.spec} (registry latest ${latest.version} is not comparable)`);
      continue;
    }
    const delta = compareTriples(published, pinned);
    if (delta > 0) {
      stale.push(
        `${pin.server}: ${packageName} pinned ${pin.version} but the registry's latest release is ${latest.version} — a vet-then-bump candidate, never an automatic upgrade`,
      );
    } else if (delta < 0) {
      unresolved.push(
        `${pin.spec} (registry latest ${latest.version} is OLDER than the pin — review the pin's provenance)`,
      );
    } else {
      current.push(pin.spec);
    }
  }

  const currentNote = current.length > 0 ? `; current: ${current.join(", ")}` : "";
  const unresolvedNote =
    unresolved.length > 0 ? `; could not resolve: ${unresolved.join("; ")}` : "";
  if (stale.length > 0) {
    return {
      name,
      verdict: "skip",
      code: "mcp.pin-stale",
      detail: `${stale.join("; ")}${projectionNote}${currentNote}${unresolvedNote}${untrackedNote}`,
    };
  }
  if (projectionLag.length > 0) {
    return {
      name,
      verdict: "skip",
      code: "mcp.projection-stale",
      detail: `${projectionLag.join("; ")}${currentNote}${unresolvedNote}${untrackedNote}`,
    };
  }
  if (unresolved.length > 0) {
    return {
      name,
      verdict: "skip",
      detail: `could not resolve: ${unresolved.join("; ")}${currentNote}${untrackedNote}`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: `${current.length} MCP package pin(s) current with their registries: ${current.join(", ")}`,
  };
}
