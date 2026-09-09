import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalBaselineVetRequestV1Bytes } from "@aihq/scan";
import { materializeAihScanSubjectsV1 } from "../src/baseline-evidence/aih-scan-material.ts";
import { createCoreBaselineVetRequests } from "../src/baseline-evidence/scanner-consumer.ts";
import { canonicalStrictJsonBytesV1 } from "../src/contract/strict-json-v1.ts";
import { policyAuthoringCatalog } from "../src/org-policy/catalog.ts";
import { compileBuiltInCatalogV1 } from "../src/org-policy/workbench/compilers/built-in.ts";

const flags = new Set(["--source", "--core-commit", "--output"]);
const values = new Map();
const argv = process.argv.slice(2);
if (argv.length !== 6) throw new Error("Expected --source, --core-commit, and --output once.");
for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index], value = argv[index + 1];
  if (!flags.has(flag) || values.has(flag) || !value || value.startsWith("--"))
    throw new Error("Invalid AIH delivery material argument.");
  values.set(flag, value);
}
const coreCommit = values.get("--core-commit");
if (!/^[a-f0-9]{40}$/.test(coreCommit)) throw new Error("Core requires an exact commit.");
const sourcePath = resolve(values.get("--source"));
const stat = lstatSync(sourcePath);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Core source must be a real directory.");
const source = realpathSync(sourcePath);
const executingRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
if (source !== executingRoot) throw new Error("Core source must be the executing helper checkout.");
const gitOptions = { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 };
if (execFileSync("git", ["-C", source, "rev-parse", "HEAD"], gitOptions).trim() !== coreCommit)
  throw new Error("AIH scan material: Core checkout revision");
if (execFileSync("git", ["-C", source, "status", "--porcelain", "--untracked-files=all"], gitOptions).trim())
  throw new Error("Core executing checkout must be clean before materialization.");
const requestedOutput = resolve(values.get("--output"));
const output = resolve(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
const withinSource = relative(source, output);
if (withinSource === "" || (!isAbsolute(withinSource) && withinSource !== ".." && !withinSource.startsWith(`..${sep}`)))
  throw new Error("AIH delivery output must be outside the Core checkout.");
mkdirSync(output, { recursive: false });
const catalog = policyAuthoringCatalog();
const material = materializeAihScanSubjectsV1({
  packageRoot: source, outputParent: output, coreRevision: { pinnedSha: coreCommit },
  catalog, compiled: compileBuiltInCatalogV1(catalog),
});
const requests = createCoreBaselineVetRequests(material.sourceRoot, material.catalog);
for (const [index, request] of requests.entries()) {
  writeFileSync(resolve(output, `batch-${String(index + 1).padStart(3, "0")}.request.json`),
    canonicalBaselineVetRequestV1Bytes(request), { flag: "wx", mode: 0o600 });
}
writeFileSync(resolve(output, "coverage.json"), canonicalStrictJsonBytesV1(material.coverage),
  { flag: "wx", mode: 0o600 });
writeFileSync(resolve(output, "materialization.json"), canonicalStrictJsonBytesV1({
  version: "aih-delivery-materialization/v1", authority: "none", sourceRoot: material.sourceRoot,
  coreCommit, sourceTreeSha256: material.coverage.sourceTreeSha256,
  requestSha256s: requests.map((request) => request.requestSha256),
}), { flag: "wx", mode: 0o600 });
