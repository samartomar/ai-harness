import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { vendorBaselineLockBytes } from "./vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "./vendor-artifact-v1.js";

function fail(label: string): never {
  throw new TypeError(`BASELINE_EVIDENCE_ARTIFACT_V1: ${label}`);
}

function safeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe output parent");
}

function claimOutputDirectory(out: string): string {
  if (typeof out !== "string" || out.length === 0) fail("output directory");
  const lexicalRoot = resolve(out);
  const lexicalParent = dirname(lexicalRoot);
  for (let current = lexicalParent; ; current = dirname(current)) {
    safeDirectory(current);
    if (dirname(current) === current) break;
  }
  const root = join(realpathSync(lexicalParent), basename(lexicalRoot));
  mkdirSync(root);
  safeDirectory(root);
  return root;
}

function parseOptions(args: readonly string[]): {
  environment: string;
  out: string;
  repository: string;
} {
  if (args.length !== 6) fail("usage");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== "--environment" && name !== "--out" && name !== "--repository") ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--") ||
      values.has(name)
    )
      fail("usage");
    values.set(name, value);
  }
  const out = values.get("--out");
  const repository = values.get("--repository");
  const environment = values.get("--environment");
  if (out === undefined || repository === undefined || environment === undefined) fail("usage");
  return { environment, out, repository };
}

export function writeVendorBaselineEvidenceArtifactV1(
  out: string,
  publisher: { environment: string; repository: string },
): void {
  const root = claimOutputDirectory(out);
  const artifact = buildVendorBaselineEvidenceArtifactV1({
    lockBytes: vendorBaselineLockBytes(),
    publisher,
  });
  mkdirSync(join(root, "files"));
  mkdirSync(join(root, "files", ".aih"));
  mkdirSync(join(root, "files", ".aih", "baseline-reports"));
  for (const file of artifact.files) {
    const target = join(root, ...file.path.split("/"));
    safeDirectory(dirname(target));
    writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  const { environment, out, repository } = parseOptions(process.argv.slice(2));
  writeVendorBaselineEvidenceArtifactV1(out, { environment, repository });
}
