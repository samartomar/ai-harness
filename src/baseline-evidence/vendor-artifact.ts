import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { vendorBaselineLockBytes } from "./vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "./vendor-artifact-v1.js";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function writeVendorBaselineEvidenceArtifactV1(
  out: string,
  publisher: { environment: string; repository: string },
): void {
  const root = resolve(out);
  const artifact = buildVendorBaselineEvidenceArtifactV1({
    lockBytes: vendorBaselineLockBytes(),
    publisher,
  });
  for (const file of artifact.files) {
    const target = join(root, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  const out = option(process.argv.slice(2), "--out");
  const repository = option(process.argv.slice(2), "--repository");
  const environment = option(process.argv.slice(2), "--environment");
  if (out === undefined || repository === undefined || environment === undefined) {
    throw new Error(
      "usage: vendor-artifact --out <dir> --repository <owner/repo> --environment <name>",
    );
  }
  writeVendorBaselineEvidenceArtifactV1(out, { environment, repository });
}
