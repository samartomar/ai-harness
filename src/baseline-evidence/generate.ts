import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { parseBaselineEvidenceLock } from "./schema.js";
import { vetBaselineCatalog } from "./vet.js";

interface GenerateOptions extends GenerateBaselineOptions {
  out: string;
  check: boolean;
  previewOut: string;
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
      "usage: baseline generate --ecc-root <dir> --superpowers-root <dir> [--out <file>] [--check]",
    );
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    eccRoot: resolve(eccRoot),
    superpowersRoot: resolve(superpowersRoot),
    out: resolve(optionValue(argv, "--out") ?? resolve(here, "vendor-lock.json")),
    previewOut: resolve(
      optionValue(argv, "--preview-out") ?? resolve(here, "ecc-install-preview.json"),
    ),
    check: argv.includes("--check"),
  };
}

function checkoutHead(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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
  const vetOptions = requiredBaselineVetOptions({ run, platform, env, progress });
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
  const lock = parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [eccEvidence, await vet(opts.superpowersRoot, superpowers, vetOptions)],
  });
  return {
    lock: `${JSON.stringify(lock, null, 2)}\n`,
    preview: `${JSON.stringify(preview, null, 2)}\n`,
  };
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const contents = await generateBaselineArtifacts(opts);
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
