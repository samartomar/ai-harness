import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineCatalogById } from "./catalogs.js";
import { parseBaselineEvidenceLock } from "./schema.js";
import { vetBaselineCatalog } from "./vet.js";

interface GenerateOptions {
  eccRoot: string;
  superpowersRoot: string;
  out: string;
  check: boolean;
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

async function generate(opts: GenerateOptions): Promise<string> {
  const ecc = baselineCatalogById("ecc");
  const superpowers = baselineCatalogById("superpowers");
  assertCheckoutPin(opts.eccRoot, ecc.pinnedSha, "ECC");
  assertCheckoutPin(opts.superpowersRoot, superpowers.pinnedSha, "Superpowers");
  const lock = parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      await vetBaselineCatalog(opts.eccRoot, ecc),
      await vetBaselineCatalog(opts.superpowersRoot, superpowers),
    ],
  });
  return `${JSON.stringify(lock, null, 2)}\n`;
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const contents = await generate(opts);
  if (opts.check) {
    const existing = readFileSync(opts.out, "utf8");
    if (existing !== contents) throw new Error(`vendor baseline lock drifted: ${opts.out}`);
    process.stdout.write(`vendor baseline lock is current: ${opts.out}\n`);
    return;
  }
  writeFileSync(opts.out, contents, "utf8");
  process.stdout.write(`wrote vendor baseline lock: ${opts.out}\n`);
}

await main();
