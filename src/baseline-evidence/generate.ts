import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineCatalogById } from "./catalogs.js";
import { generateAuthorizedEccInstallPreview } from "./ecc-preview-boundary.js";
import { parseBaselineEvidenceLock } from "./schema.js";
import { vetBaselineCatalog } from "./vet.js";

interface GenerateOptions {
  eccRoot: string;
  superpowersRoot: string;
  out: string;
  check: boolean;
  previewOut: string;
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

function assertCheckoutPin(root: string, pin: string, label: string): void {
  const head = checkoutHead(root);
  if (head !== pin) throw new Error(`${label} checkout is ${head}, expected pinned ${pin}`);
}

async function generate(opts: GenerateOptions): Promise<{ lock: string; preview: string }> {
  const ecc = baselineCatalogById("ecc");
  const superpowers = baselineCatalogById("superpowers");
  assertCheckoutPin(opts.eccRoot, ecc.pinnedSha, "ECC");
  assertCheckoutPin(opts.superpowersRoot, superpowers.pinnedSha, "Superpowers");
  const eccEvidence = await vetBaselineCatalog(opts.eccRoot, ecc);
  const preview = generateAuthorizedEccInstallPreview({
    eccRoot: opts.eccRoot,
    catalog: ecc,
    evidence: eccEvidence,
  });
  const lock = parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [eccEvidence, await vetBaselineCatalog(opts.superpowersRoot, superpowers)],
  });
  return {
    lock: `${JSON.stringify(lock, null, 2)}\n`,
    preview: `${JSON.stringify(preview, null, 2)}\n`,
  };
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const contents = await generate(opts);
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

await main();
