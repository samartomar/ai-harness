import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { containedPath } from "../internals/contained-path.js";
import { readRegularFile } from "../internals/fsxn.js";
import { hermeticGitEnv } from "../internals/git-env.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import { resolvePlatform } from "../platform/detect.js";
import {
  preflightRequiredBaselineAnalyzers,
  requiredBaselineVetOptions,
} from "./analyzer-profile.js";
import type { BaselineCatalog } from "./catalog.js";
import { baselineCatalogById } from "./catalogs.js";
import {
  assertEccPreflightReceipt,
  buildEccPreflightReceipt,
  type EccPreflightReceipt,
  parseEccPreflightReceipt,
} from "./ecc-preflight-receipt.js";
import { generateAuthorizedEccInstallPreview } from "./ecc-preview-boundary.js";
import { findPriorSource, formatTotalReuseSummary, tallyReuse } from "./reuse.js";
import {
  type BaselineEvidenceLock,
  type BaselineSourceEvidence,
  parseBaselineEvidenceLock,
} from "./schema.js";
import {
  formatShardCoverage,
  mergeReceiptBundles,
  parseShardSelector,
  type ShardSelector,
  shardCatalog,
  shardCoverage,
} from "./shard.js";
import { vetBaselineCatalog } from "./vet.js";

export interface GenerateOptions extends Omit<GenerateBaselineOptions, "superpowersRoot"> {
  superpowersRoot?: string;
  out: string;
  check: boolean;
  previewOut: string;
  full: boolean;
  /** Static-only dispatcher preflight; it writes no baseline evidence. */
  preflightOnly: boolean;
  preflightReceiptOut?: string;
  preflightReceiptPath?: string;
  /** Fan-out: vet only this shard of each catalog and write receipts, no lock. */
  shard?: ShardSelector;
  receiptsOut?: string;
  /** Fan-in: shard receipt bundles to seed reuse from, instead of the prior lock. */
  reuseFromPaths: readonly string[];
}

export interface GenerateBaselineOptions {
  eccRoot: string;
  superpowersRoot: string;
}

export interface GenerateBaselineDependencies {
  run?: Runner;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  progress?: (message: string) => void;
  vetCatalog?: typeof vetBaselineCatalog;
  checkoutHead?: (root: string, catalog: BaselineCatalog) => string;
  generatePreview?: (input: Parameters<typeof generateAuthorizedEccInstallPreview>[0]) => unknown;
  preflight?: (runtime: {
    run: Runner;
    platform: Platform;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>;
  /** Verified static preflight evidence required only for shard fan-in. */
  eccPreflightReceipt?: EccPreflightReceipt;
  /** Prior lock enabling incremental reuse (Decision 1); omit for a full vet. */
  reuseFrom?: BaselineEvidenceLock;
  /** Disable reuse outright — the release/periodic ground-truth escape hatch and
   * the migration tool (Decision 5). */
  full?: boolean;
}

function optionValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseGenerateOptions(argv: readonly string[]): GenerateOptions {
  const eccRoot = optionValue(argv, "--ecc-root");
  const superpowersRoot = optionValue(argv, "--superpowers-root");
  const preflightOnly = argv.includes("--preflight-only");
  if (!eccRoot || (!superpowersRoot && !preflightOnly)) {
    throw new Error(
      "usage: baseline generate --ecc-root <dir> [--superpowers-root <dir>] [--preflight-only --preflight-receipt-out <file>] [--out <file>] [--check] [--full]",
    );
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const shardValue = optionValue(argv, "--shard");
  const receiptsOut = optionValue(argv, "--receipts-out");
  const preflightReceiptOut = optionValue(argv, "--preflight-receipt-out");
  const preflightReceipt = optionValue(argv, "--preflight-receipt");
  const preflightOnlyConflicts = [
    "--superpowers-root",
    "--shard",
    "--reuse-from",
    "--check",
    "--full",
    "--out",
    "--preview-out",
    "--receipts-out",
    "--preflight-receipt",
  ].filter((flag) => argv.includes(flag));
  if (preflightOnly && preflightOnlyConflicts.length > 0) {
    throw new Error(
      `--preflight-only cannot be combined with ${preflightOnlyConflicts.join(", ")}`,
    );
  }
  if (preflightOnly && preflightReceiptOut === undefined) {
    throw new Error("--preflight-only requires --preflight-receipt-out <file>");
  }
  if (!preflightOnly && preflightReceiptOut !== undefined) {
    throw new Error("--preflight-receipt-out requires --preflight-only");
  }
  if (shardValue !== undefined && receiptsOut === undefined) {
    throw new Error("--shard requires --receipts-out <file>");
  }
  if (shardValue !== undefined && preflightReceipt === undefined) {
    throw new Error("--shard requires --preflight-receipt <file>");
  }
  const reuseFromPaths = (optionValue(argv, "--reuse-from") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry));
  if (reuseFromPaths.length > 0 && preflightReceipt === undefined) {
    throw new Error("--reuse-from requires --preflight-receipt <file>");
  }
  if (shardValue !== undefined && reuseFromPaths.length > 0) {
    throw new Error("--shard cannot be combined with --reuse-from");
  }
  if (
    !preflightOnly &&
    preflightReceipt !== undefined &&
    shardValue === undefined &&
    reuseFromPaths.length === 0
  ) {
    throw new Error("--preflight-receipt requires --shard or --reuse-from");
  }
  return {
    eccRoot: resolve(eccRoot),
    ...(superpowersRoot !== undefined ? { superpowersRoot: resolve(superpowersRoot) } : {}),
    out: resolve(optionValue(argv, "--out") ?? resolve(here, "vendor-lock.json")),
    previewOut: resolve(
      optionValue(argv, "--preview-out") ?? resolve(here, "ecc-install-preview.json"),
    ),
    check: argv.includes("--check"),
    full: argv.includes("--full"),
    preflightOnly,
    ...(shardValue !== undefined ? { shard: parseShardSelector(shardValue) } : {}),
    ...(receiptsOut !== undefined ? { receiptsOut: resolve(receiptsOut) } : {}),
    ...(preflightReceiptOut !== undefined
      ? { preflightReceiptOut: resolve(preflightReceiptOut) }
      : {}),
    ...(preflightReceipt !== undefined ? { preflightReceiptPath: resolve(preflightReceipt) } : {}),
    reuseFromPaths,
  };
}

/** Best-effort prior-lock read for incremental reuse (Decision 1): absent, unreadable,
 * or schema-invalid all degrade to "no reuseFrom" (a full vet), never a hard error —
 * reuse is a speed optimization, and its absence is always safe. */
function readPriorLockBestEffort(path: string): BaselineEvidenceLock | undefined {
  try {
    return parseBaselineEvidenceLock(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Read and merge shard receipt bundles. Unlike the prior-lock read above this
 * is STRICT: an unreadable or invalid bundle throws. Degrading to "no reuse"
 * would be silently correct but operationally wrong — the fan-out would have
 * been wasted and the assembly run would look merely slow instead of broken.
 */
function mergeShardReceipts(paths: readonly string[]): BaselineEvidenceLock | undefined {
  if (paths.length === 0) return undefined;
  return mergeReceiptBundles(
    paths.map((path) => {
      try {
        return parseBaselineEvidenceLock(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        throw new Error(
          `unusable shard receipt bundle ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}

function checkoutHead(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // `-C` alone does not pin the repo: an inherited GIT_DIR outranks it and
    // would pin the baseline to another checkout's HEAD (see internals/git-env.ts).
    env: hermeticGitEnv(),
  }).trim();
}

function assertCheckoutPin(
  root: string,
  catalog: BaselineCatalog,
  label: string,
  readHead: NonNullable<GenerateBaselineDependencies["checkoutHead"]>,
): void {
  const head = readHead(root, catalog);
  if (head !== catalog.pinnedSha) {
    throw new Error(`${label} checkout is ${head}, expected pinned ${catalog.pinnedSha}`);
  }
}

export function readVerifiedEccPreflightReceipt(
  path: string,
  eccRoot: string,
  catalog: BaselineCatalog,
): ReturnType<typeof parseEccPreflightReceipt> {
  const receiptBytes = readRegularFile(path, { maxBytes: 65_536 });
  if (receiptBytes === undefined) throw new Error("unusable ECC preflight receipt");
  let value: unknown;
  try {
    value = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("unusable ECC preflight receipt");
  }
  const receipt = parseEccPreflightReceipt(value);
  return assertEccPreflightReceipt({ eccRoot, catalog, receipt });
}

export function assertEccPreflightReceiptPathOutsideSource(
  eccRoot: string,
  receiptPath: string,
): void {
  let rootReal: string;
  try {
    rootReal = realpathSync.native(eccRoot);
  } catch {
    throw new Error("ECC preflight receipt path cannot be checked against the source root");
  }
  const absoluteReceipt = resolve(receiptPath);
  if (containedPath(rootReal, absoluteReceipt)) {
    throw new Error("ECC preflight receipt path must be outside the ECC source root");
  }
  let cursor = absoluteReceipt;
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      if (containedPath(rootReal, realpathSync.native(cursor))) {
        throw new Error("ECC preflight receipt path must be outside the ECC source root");
      }
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "ECC preflight receipt path must be outside the ECC source root"
      ) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  throw new Error("ECC preflight receipt path cannot be checked against the source root");
}

function assertPreflightCoversCompletedEvidence(
  receipt: EccPreflightReceipt,
  evidence: BaselineSourceEvidence,
): void {
  if (evidence.sourceTreeSha256 !== receipt.source.sourceTreeSha256) {
    throw new Error("ECC preflight receipt does not cover the completed baseline evidence");
  }
}

export async function generateBaselineArtifacts(
  opts: GenerateBaselineOptions,
  deps: GenerateBaselineDependencies = {},
): Promise<{ lock: string; preview: string }> {
  const ecc = baselineCatalogById("ecc");
  const superpowers = baselineCatalogById("superpowers");
  const readHead = deps.checkoutHead ?? ((root: string) => checkoutHead(root));
  assertCheckoutPin(opts.eccRoot, ecc, "ECC", readHead);
  assertCheckoutPin(opts.superpowersRoot, superpowers, "Superpowers", readHead);
  const run = deps.run ?? defaultRunner;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? resolvePlatform(env);
  const progress = deps.progress ?? ((message: string) => process.stderr.write(`${message}\n`));
  const vet = deps.vetCatalog ?? vetBaselineCatalog;
  const preflightReceipt =
    deps.eccPreflightReceipt === undefined
      ? undefined
      : assertEccPreflightReceipt({
          eccRoot: opts.eccRoot,
          catalog: ecc,
          receipt: deps.eccPreflightReceipt,
        });
  const full = deps.full === true;
  const vetOptions = {
    ...requiredBaselineVetOptions({ run, platform, env, progress }),
    reuseFrom: deps.reuseFrom,
    full,
  };
  // Fail fast, before a multi-minute vet, if a required analyzer is not runnable
  // offline in this environment. Keeps fail-closed while making the reason
  // actionable instead of aborting mid-vet with an opaque missing-analyzer error.
  const preflight = deps.preflight ?? preflightRequiredBaselineAnalyzers;
  await preflight({ run, platform, env });
  const eccEvidence = await vet(opts.eccRoot, ecc, vetOptions);
  if (preflightReceipt !== undefined) {
    assertPreflightCoversCompletedEvidence(preflightReceipt, eccEvidence);
  }
  const superpowersEvidence = await vet(opts.superpowersRoot, superpowers, vetOptions);
  const generatePreview = deps.generatePreview ?? generateAuthorizedEccInstallPreview;
  const preview = generatePreview({
    eccRoot: opts.eccRoot,
    catalog: ecc,
    evidence: eccEvidence,
  });
  progress(
    formatTotalReuseSummary(
      [
        tallyReuse(findPriorSource(deps.reuseFrom, ecc), eccEvidence, full),
        tallyReuse(findPriorSource(deps.reuseFrom, superpowers), superpowersEvidence, full),
      ],
      full,
    ),
  );
  const lock = parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [eccEvidence, superpowersEvidence],
  });
  return {
    lock: `${JSON.stringify(lock, null, 2)}\n`,
    preview: `${JSON.stringify(preview, null, 2)}\n`,
  };
}

/**
 * Vet one shard of each catalog from scratch and return its receipt bundle.
 *
 * Deliberately does NOT produce the install preview or a complete lock: a shard
 * holds partial evidence and must never look like a publishable artifact. Reuse
 * is disabled outright, because the whole point of a shard is to produce fresh
 * receipts for the assembly run to verify.
 */
export async function generateShardReceipts(
  opts: GenerateBaselineOptions & { shard: ShardSelector; preflightReceipt: unknown },
  deps: Omit<GenerateBaselineDependencies, "reuseFrom" | "full"> = {},
): Promise<string> {
  const fullEcc = baselineCatalogById("ecc");
  assertEccPreflightReceipt({
    eccRoot: opts.eccRoot,
    catalog: fullEcc,
    receipt: opts.preflightReceipt,
  });
  const ecc = shardCatalog(fullEcc, opts.shard);
  const superpowers = shardCatalog(baselineCatalogById("superpowers"), opts.shard);
  const readHead = deps.checkoutHead ?? ((root: string) => checkoutHead(root));
  assertCheckoutPin(opts.eccRoot, ecc, "ECC", readHead);
  assertCheckoutPin(opts.superpowersRoot, superpowers, "Superpowers", readHead);
  const run = deps.run ?? defaultRunner;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? resolvePlatform(env);
  const progress = deps.progress ?? ((message: string) => process.stderr.write(`${message}\n`));
  const vet = deps.vetCatalog ?? vetBaselineCatalog;
  const vetOptions = {
    ...requiredBaselineVetOptions({ run, platform, env, progress }),
    full: true as const,
  };
  const preflight = deps.preflight ?? preflightRequiredBaselineAnalyzers;
  await preflight({ run, platform, env });
  progress(
    `baseline shard ${opts.shard.index}/${opts.shard.total}: ` +
      `ecc ${ecc.components.length} + superpowers ${superpowers.components.length} components`,
  );
  const eccEvidence = await vet(opts.eccRoot, ecc, vetOptions);
  assertPreflightCoversCompletedEvidence(
    assertEccPreflightReceipt({
      eccRoot: opts.eccRoot,
      catalog: fullEcc,
      receipt: opts.preflightReceipt,
    }),
    eccEvidence,
  );
  const sources = [eccEvidence, await vet(opts.superpowersRoot, superpowers, vetOptions)];
  const bundle = parseBaselineEvidenceLock({ schemaVersion: 1, sources });
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

async function main(): Promise<void> {
  const opts = parseGenerateOptions(process.argv.slice(2));
  const { shard, receiptsOut } = opts;
  const ecc = baselineCatalogById("ecc");
  if (opts.preflightOnly) {
    const receiptOut = opts.preflightReceiptOut;
    if (receiptOut === undefined)
      throw new Error("--preflight-only requires --preflight-receipt-out");
    assertEccPreflightReceiptPathOutsideSource(opts.eccRoot, receiptOut);
    assertCheckoutPin(opts.eccRoot, ecc, "ECC", checkoutHead);
    const receipt = buildEccPreflightReceipt({ eccRoot: opts.eccRoot, catalog: ecc });
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ECC static preflight receipt: ${receiptOut}\n`);
    return;
  }
  const superpowersRoot = opts.superpowersRoot;
  if (superpowersRoot === undefined) throw new Error("--superpowers-root is required");
  let eccPreflightReceipt: EccPreflightReceipt | undefined;
  if (shard !== undefined && receiptsOut !== undefined) {
    const receiptPath = opts.preflightReceiptPath;
    if (receiptPath === undefined) throw new Error("--shard requires --preflight-receipt");
    assertEccPreflightReceiptPathOutsideSource(opts.eccRoot, receiptPath);
    const preflightReceipt = readVerifiedEccPreflightReceipt(receiptPath, opts.eccRoot, ecc);
    const receipts = await generateShardReceipts({
      eccRoot: opts.eccRoot,
      superpowersRoot,
      shard,
      preflightReceipt,
    });
    writeFileSync(receiptsOut, receipts, "utf8");
    process.stdout.write(`wrote shard ${shard.index}/${shard.total} receipts: ${receiptsOut}\n`);
    return;
  }
  if (opts.reuseFromPaths.length > 0) {
    const receiptPath = opts.preflightReceiptPath;
    if (receiptPath === undefined) throw new Error("--reuse-from requires --preflight-receipt");
    assertEccPreflightReceiptPathOutsideSource(opts.eccRoot, receiptPath);
    eccPreflightReceipt = readVerifiedEccPreflightReceipt(receiptPath, opts.eccRoot, ecc);
  }
  const merged = mergeShardReceipts(opts.reuseFromPaths);
  const reuseFrom = opts.full ? undefined : (merged ?? readPriorLockBestEffort(opts.out));
  if (merged !== undefined) {
    const catalogs = [baselineCatalogById("ecc"), baselineCatalogById("superpowers")];
    for (const line of formatShardCoverage(shardCoverage(catalogs, merged))) {
      process.stderr.write(`${line}\n`);
    }
  }
  const contents = await generateBaselineArtifacts(
    { eccRoot: opts.eccRoot, superpowersRoot },
    {
      reuseFrom,
      full: opts.full,
      ...(eccPreflightReceipt !== undefined ? { eccPreflightReceipt } : {}),
    },
  );
  if (opts.check) {
    const existing = readFileSync(opts.out, "utf8");
    if (existing !== contents.lock) throw new Error(`vendor baseline lock drifted: ${opts.out}`);
    const existingPreview = readFileSync(opts.previewOut, "utf8");
    if (existingPreview !== contents.preview) {
      throw new Error(`ECC install preview drifted: ${opts.previewOut}`);
    }
    process.stdout.write(
      `vendor baseline lock and ECC install preview are current: ${opts.out}, ${opts.previewOut}\n`,
    );
    return;
  }
  writeFileSync(opts.out, contents.lock, "utf8");
  writeFileSync(opts.previewOut, contents.preview, "utf8");
  process.stdout.write(`wrote vendor baseline lock and ECC install preview\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main();
}
