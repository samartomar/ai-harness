import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { generateAuthorizedEccInstallPreview } from "./ecc-preview-boundary.js";
import { findPriorSource, formatTotalReuseSummary, tallyReuse } from "./reuse.js";
import { type BaselineEvidenceLock, parseBaselineEvidenceLock } from "./schema.js";
import {
  formatShardCoverage,
  mergeReceiptBundles,
  parseShardSelector,
  type ShardSelector,
  shardCatalog,
  shardCoverage,
} from "./shard.js";
import { vetBaselineCatalog } from "./vet.js";

interface GenerateOptions extends GenerateBaselineOptions {
  out: string;
  check: boolean;
  previewOut: string;
  full: boolean;
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
  /** Prior lock enabling incremental reuse (Decision 1); omit for a full vet. */
  reuseFrom?: BaselineEvidenceLock;
  /** Disable reuse outright — the release/periodic ground-truth escape hatch and
   * the migration tool (Decision 5). */
  full?: boolean;
}

function optionValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function options(argv: readonly string[]): GenerateOptions {
  const eccRoot = optionValue(argv, "--ecc-root");
  const superpowersRoot = optionValue(argv, "--superpowers-root");
  if (!eccRoot || !superpowersRoot) {
    throw new Error(
      "usage: baseline generate --ecc-root <dir> --superpowers-root <dir> [--out <file>] [--check] [--full]",
    );
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const shardValue = optionValue(argv, "--shard");
  const receiptsOut = optionValue(argv, "--receipts-out");
  if (shardValue !== undefined && receiptsOut === undefined) {
    throw new Error("--shard requires --receipts-out <file>");
  }
  const reuseFromPaths = (optionValue(argv, "--reuse-from") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry));
  return {
    eccRoot: resolve(eccRoot),
    superpowersRoot: resolve(superpowersRoot),
    out: resolve(optionValue(argv, "--out") ?? resolve(here, "vendor-lock.json")),
    previewOut: resolve(
      optionValue(argv, "--preview-out") ?? resolve(here, "ecc-install-preview.json"),
    ),
    check: argv.includes("--check"),
    full: argv.includes("--full"),
    ...(shardValue !== undefined ? { shard: parseShardSelector(shardValue) } : {}),
    ...(receiptsOut !== undefined ? { receiptsOut: resolve(receiptsOut) } : {}),
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
  const generatePreview = deps.generatePreview ?? generateAuthorizedEccInstallPreview;
  const preview = generatePreview({
    eccRoot: opts.eccRoot,
    catalog: ecc,
    evidence: eccEvidence,
  });
  const superpowersEvidence = await vet(opts.superpowersRoot, superpowers, vetOptions);
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
  opts: GenerateBaselineOptions & { shard: ShardSelector },
  deps: Omit<GenerateBaselineDependencies, "reuseFrom" | "full"> = {},
): Promise<string> {
  const ecc = shardCatalog(baselineCatalogById("ecc"), opts.shard);
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
  const sources = [
    await vet(opts.eccRoot, ecc, vetOptions),
    await vet(opts.superpowersRoot, superpowers, vetOptions),
  ];
  const bundle = parseBaselineEvidenceLock({ schemaVersion: 1, sources });
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const { shard, receiptsOut } = opts;
  if (shard !== undefined && receiptsOut !== undefined) {
    const receipts = await generateShardReceipts({ ...opts, shard });
    writeFileSync(receiptsOut, receipts, "utf8");
    process.stdout.write(`wrote shard ${shard.index}/${shard.total} receipts: ${receiptsOut}\n`);
    return;
  }
  const merged = mergeShardReceipts(opts.reuseFromPaths);
  const reuseFrom = opts.full ? undefined : (merged ?? readPriorLockBestEffort(opts.out));
  if (merged !== undefined) {
    const catalogs = [baselineCatalogById("ecc"), baselineCatalogById("superpowers")];
    for (const line of formatShardCoverage(shardCoverage(catalogs, merged))) {
      process.stderr.write(`${line}\n`);
    }
  }
  const contents = await generateBaselineArtifacts(opts, { reuseFrom, full: opts.full });
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
