import { createHash } from "node:crypto";
import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { prepareOwnedStateDirectory } from "../ecc-profile/native-runtime.js";
import { AihError } from "../errors.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Runner } from "../internals/proc.js";
import { defaultNativeRuntimeLayout } from "../mcp/default-native-runtime.js";
import {
  externalExecutable,
  initializedMcpRequests,
  LOCAL_TIMEOUT_MS,
  localMcpResponse,
  MCP_OUTPUT_LIMIT,
  requireSuccess,
  sequencedMcpInput,
  verifyToolCall,
  verifyToolsList,
} from "./developer-tools-operations.js";
import {
  authenticateHeadroomRuntimeRoot,
  HEADROOM_MCP_TOOL_NAMES,
  HEADROOM_RUNTIME_PIN,
  HEADROOM_TOKENIZER_VOCABULARIES,
  type HeadroomLayout,
  headroomLauncherDigest,
  headroomLayout,
  headroomMcpServer,
  headroomPlatform,
  isolatedHeadroomEnvironment,
} from "./headroom.js";
import {
  type HeadroomActivationReceipt,
  headroomReceiptFor,
  readHeadroomReceipt,
  stableHeadroomReceipt,
  writeHeadroomReceipt,
} from "./headroom-receipt.js";

const SYNC_TIMEOUT_MS = 15 * 60_000;
const VOCABULARY_READY = "aih-headroom-vocabularies-ready";
const ACTIVATE =
  "re-run with --activate-headroom --accept-headroom-egress to install it, or --deactivate-headroom to remove it";

export interface HeadroomRequest {
  readonly activate: boolean;
  readonly deactivate: boolean;
}

export interface HeadroomLifecycleDeps {
  /** Process seam; production uses the command context runner. */
  readonly run?: Runner;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly now?: () => Date;
  /** Focused tests replace the published-vocabulary hash check. */
  readonly verifyVocabularies?: (layout: HeadroomLayout) => void;
}

export interface HeadroomOutcome {
  readonly state: "verified" | "blocked" | "selected-pending" | "policy-excluded";
  readonly detail: string;
  readonly changed: boolean;
}

/** Validate the explicit lifecycle flags before any other work. */
export function headroomRequestFrom(options: Record<string, unknown>): HeadroomRequest {
  const activate = options.activateHeadroom === true;
  const accept = options.acceptHeadroomEgress === true;
  const deactivate = options.deactivateHeadroom === true;
  if (activate && deactivate) {
    throw new AihError(
      "--activate-headroom and --deactivate-headroom cannot be combined",
      "AIH_CONFIG",
    );
  }
  if (activate && !accept) {
    throw new AihError(
      "--activate-headroom requires --accept-headroom-egress: activation downloads the pinned headroom-ai[mcp] 0.38.0 wheels from PyPI and two tokenizer vocabularies from openaipublic.blob.core.windows.net; see the Headroom privacy and egress notes in docs/commands.md",
      "AIH_CONFIG",
    );
  }
  if (accept && !activate) {
    throw new AihError(
      "--accept-headroom-egress is only valid with --activate-headroom",
      "AIH_CONFIG",
    );
  }
  return { activate, deactivate };
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertStateBoundary(ctx: PlanContext, layout: HeadroomLayout): void {
  const native = defaultNativeRuntimeLayout(ctx);
  if (
    !contains(native.projectStateRoot, layout.stateRoot) ||
    contains(layout.project, layout.stateRoot) ||
    contains(layout.stateRoot, layout.project)
  ) {
    throw new Error("Headroom state must remain inside AIH project state and outside the project");
  }
}

/** tiktoken caches each vocabulary under sha1(url); check the published hashes. */
function verifyPublishedVocabularies(layout: HeadroomLayout): void {
  for (const vocabulary of HEADROOM_TOKENIZER_VOCABULARIES) {
    const path = join(
      layout.tiktokenCache,
      createHash("sha1").update(vocabulary.url).digest("hex"),
    );
    const opened = readRegularFileWithStats(path, { maxBytes: 32 * 1024 * 1024 });
    if (opened === undefined || opened.stats.nlink !== 1) {
      throw new Error(`Headroom ${vocabulary.encoding} tokenizer vocabulary is not provisioned`);
    }
    if (sha256(opened.contents) !== vocabulary.sha256) {
      throw new Error(`Headroom ${vocabulary.encoding} tokenizer vocabulary failed authentication`);
    }
  }
}

function prepareStateDirectories(layout: HeadroomLayout): void {
  prepareOwnedStateDirectory(layout.stateRoot, "Headroom state root");
  for (const [path, label] of [
    [layout.uvCache, "Headroom uv cache"],
    [layout.workspace, "Headroom workspace"],
    [layout.tiktokenCache, "Headroom tokenizer cache"],
    [layout.huggingFaceHome, "Headroom Hugging Face home"],
  ] as const) {
    prepareOwnedStateDirectory(path, label);
  }
}

/**
 * The health contract: initialize, an exact three-tool list, and a real
 * `headroom_stats` call through the generated launcher the hosts will run.
 */
async function headroomHandshake(ctx: PlanContext, run: Runner): Promise<string> {
  const server = headroomMcpServer(ctx);
  const result = await run([server.command, ...server.args], {
    cwd: ctx.root,
    env: ctx.env,
    inputSequence: sequencedMcpInput(
      initializedMcpRequests({ name: "headroom_stats", arguments: {} }),
    ),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxBufferBytes: MCP_OUTPUT_LIMIT,
  });
  requireSuccess("Headroom generated MCP launcher", result);
  const initialized = localMcpResponse(result.stdout, 1);
  const info = initialized.serverInfo as { name?: unknown } | undefined;
  if (info?.name !== "headroom") {
    throw new Error("Headroom MCP initialize did not identify the headroom server");
  }
  verifyToolsList(localMcpResponse(result.stdout, 2), HEADROOM_MCP_TOOL_NAMES, true);
  const text = verifyToolCall(localMcpResponse(result.stdout, 3), "Headroom headroom_stats");
  let stats: unknown;
  try {
    stats = JSON.parse(text);
  } catch {
    throw new Error("Headroom headroom_stats returned a non-JSON result");
  }
  const compressions = (stats as { compressions?: unknown } | null)?.compressions;
  if (typeof compressions !== "number" || !Number.isSafeInteger(compressions) || compressions < 0) {
    throw new Error("Headroom headroom_stats did not report its session counters");
  }
  return `generated launcher completed initialize, listed exactly ${HEADROOM_MCP_TOOL_NAMES.join(", ")}, and answered headroom_stats`;
}

function unsupportedPlatformDetail(platform: string, arch: string): string {
  return `Headroom ${HEADROOM_RUNTIME_PIN.version} has no complete prebuilt wheel closure for ${platform}-${arch} (supported: ${Object.keys(HEADROOM_RUNTIME_PIN.wheels).join(", ")}); nothing was downloaded`;
}

/**
 * Explicit, consented activation: locked sync, vocabulary pre-provisioning, a
 * consent receipt, then the real handshake. A failed handshake rolls back the
 * receipt, so no host entry is projected for an unverified runtime.
 */
export async function activateHeadroom(
  ctx: PlanContext,
  hosts: readonly string[],
  deps: HeadroomLifecycleDeps = {},
): Promise<HeadroomOutcome> {
  const platformName = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const platform = headroomPlatform(platformName, arch);
  if (platform === undefined) {
    return {
      state: "blocked",
      detail: unsupportedPlatformDetail(platformName, arch),
      changed: false,
    };
  }
  const run = deps.run ?? ctx.run;
  const layout = headroomLayout(ctx);
  let changed = false;
  let receiptWritten = false;
  let rollback: () => void = () => undefined;
  try {
    assertStateBoundary(ctx, layout);
    const previous = readHeadroomReceipt(layout);
    if (previous.state === "invalid") {
      throw new Error(
        `the existing Headroom activation receipt is invalid (${previous.reason}); run --deactivate-headroom first`,
      );
    }
    const environmentExisted =
      lstatSync(layout.environment, { throwIfNoEntry: false }) !== undefined;
    prepareStateDirectories(layout);
    const lockRoot = authenticateHeadroomRuntimeRoot(layout.lockRoot, layout.project, [
      layout.stateRoot,
    ]);
    const uv = externalExecutable("uv", ctx);
    const acquisition = isolatedHeadroomEnvironment(ctx.env, layout, "acquisition");
    const sync = await run(
      [
        uv,
        "--project",
        lockRoot,
        "sync",
        "--locked",
        "--no-python-downloads",
        "--no-config",
        "--no-build",
        "--compile-bytecode",
      ],
      {
        cwd: lockRoot,
        env: acquisition,
        timeoutMs: SYNC_TIMEOUT_MS,
        maxBufferBytes: MCP_OUTPUT_LIMIT,
      },
    );
    requireSuccess("Headroom locked dependency sync", sync);
    changed = !environmentExisted;
    const names = HEADROOM_TOKENIZER_VOCABULARIES.map(({ encoding }) => `"${encoding}"`).join(", ");
    const vocabularies = await run(
      [
        uv,
        "--project",
        lockRoot,
        "run",
        "--offline",
        "--no-python-downloads",
        "--no-env-file",
        "--frozen",
        "--no-config",
        "python",
        "-c",
        `import tiktoken\nfor name in (${names},):\n    tiktoken.get_encoding(name)\nprint("${VOCABULARY_READY}")\n`,
      ],
      {
        cwd: layout.workspace,
        env: acquisition,
        timeoutMs: LOCAL_TIMEOUT_MS,
        maxBufferBytes: MCP_OUTPUT_LIMIT,
      },
    );
    requireSuccess("Headroom tokenizer vocabulary provisioning", vocabularies);
    if (!vocabularies.stdout.includes(VOCABULARY_READY)) {
      throw new Error("Headroom tokenizer vocabulary provisioning did not complete");
    }
    (deps.verifyVocabularies ?? verifyPublishedVocabularies)(layout);

    const server = headroomMcpServer(ctx);
    const kept =
      previous.state === "valid" &&
      previous.receipt.launcher.sha256 === headroomLauncherDigest(server) &&
      JSON.stringify(previous.receipt.hosts) === JSON.stringify(hosts)
        ? previous.receipt
        : undefined;
    const receipt =
      kept ??
      headroomReceiptFor({
        layout,
        platform,
        acceptedAt: (deps.now ?? (() => new Date()))().toISOString(),
        hosts,
        server,
      });
    receiptWritten = writeHeadroomReceipt(
      layout,
      receipt,
      previous.state === "absent" ? undefined : previous.sha256,
    );
    changed ||= receiptWritten;
    // An unverified runtime must not be projected: restore the earlier receipt
    // (or none) when this activation's handshake fails.
    rollback = () => {
      if (!receiptWritten) return;
      const written = sha256(stableHeadroomReceipt(receipt));
      if (previous.state === "absent") rmSync(layout.receiptPath, { force: true });
      else writeHeadroomReceipt(layout, previous.receipt, written);
    };
    const detail = await headroomHandshake(ctx, run);
    return {
      state: "verified",
      detail: `Headroom ${HEADROOM_RUNTIME_PIN.version} MCP was activated with recorded egress consent (${receipt.consent.acceptedAt}) from the hash-locked closure for ${platform}; the ${detail}`,
      changed,
    };
  } catch (error) {
    rollback();
    return {
      state: "blocked",
      detail: `Headroom activation was blocked: ${message(error)}`,
      changed,
    };
  }
}

/** Ordinary reconciliation of an activated worktree: offline health only, never a download. */
export async function verifyActiveHeadroom(
  ctx: PlanContext,
  deps: HeadroomLifecycleDeps = {},
): Promise<HeadroomOutcome> {
  const layout = headroomLayout(ctx);
  const current = readHeadroomReceipt(layout);
  if (current.state === "absent") {
    return {
      state: "selected-pending",
      detail:
        "selected; not activated. Activation is explicit: pass --activate-headroom --accept-headroom-egress with --apply",
      changed: false,
    };
  }
  if (current.state === "invalid") {
    return {
      state: "blocked",
      detail: `Headroom activation receipt is invalid (${current.reason}); ${ACTIVATE}`,
      changed: false,
    };
  }
  if (current.state === "stale") {
    return {
      state: "blocked",
      detail: `Headroom activation is stale: ${current.reason}; ${ACTIVATE}`,
      changed: false,
    };
  }
  let changed = false;
  try {
    assertStateBoundary(ctx, layout);
    (deps.verifyVocabularies ?? verifyPublishedVocabularies)(layout);
    const server = headroomMcpServer(ctx);
    if (current.receipt.launcher.sha256 !== headroomLauncherDigest(server)) {
      const updated: HeadroomActivationReceipt = {
        ...current.receipt,
        launcher: { sha256: headroomLauncherDigest(server), server },
      };
      changed = writeHeadroomReceipt(layout, updated, current.sha256);
    }
    const detail = await headroomHandshake(ctx, deps.run ?? ctx.run);
    return {
      state: "verified",
      detail: `Headroom ${HEADROOM_RUNTIME_PIN.version} MCP is active (consent recorded ${current.receipt.consent.acceptedAt}); the ${detail}`,
      changed,
    };
  } catch (error) {
    return {
      state: "blocked",
      detail: `Headroom health check failed: ${message(error)}`,
      changed,
    };
  }
}

function assertUnlinkedAncestry(path: string): void {
  let cursor = parse(path).root;
  for (const segment of relative(cursor, path)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    cursor = resolve(cursor, segment);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (stats === undefined) return;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Headroom state root has a non-directory or linked path segment");
    }
  }
}

/**
 * Remove the single AIH-owned Headroom root: runtime, caches, workspace and,
 * last, the receipt. Host entries are removed separately by the projection,
 * which compares them byte for byte with the recorded launcher.
 */
export function removeHeadroomState(ctx: PlanContext): { changed: boolean; detail: string } {
  const layout = headroomLayout(ctx);
  assertStateBoundary(ctx, layout);
  if (lstatSync(layout.stateRoot, { throwIfNoEntry: false }) === undefined) {
    return { changed: false, detail: "no AIH-owned Headroom state was present" };
  }
  assertUnlinkedAncestry(layout.stateRoot);
  const receiptName = relative(layout.stateRoot, layout.receiptPath);
  try {
    for (const entry of readdirSync(layout.stateRoot)) {
      if (entry === receiptName) continue;
      rmSync(join(layout.stateRoot, entry), { recursive: true, force: true, maxRetries: 3 });
    }
    rmSync(layout.receiptPath, { force: true });
    rmdirSync(layout.stateRoot);
  } catch (error) {
    throw new Error(
      `Headroom state could not be fully removed (${message(error)}); stop MCP clients that are running Headroom and retry --deactivate-headroom`,
    );
  }
  return {
    changed: true,
    detail: "removed the AIH-owned Headroom runtime, caches, workspace and activation receipt",
  };
}
