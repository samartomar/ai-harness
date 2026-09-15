/**
 * Public, disposable-consumer acceptance for governed selected ECC content.
 *
 * It delegates mutation to the published-CLI lifecycle verifier and records
 * the resulting receipt identities as a client-by-client discovery contract.
 * The contract deliberately distinguishes materialized paths from native
 * catalog observation: this script never launches a client or attaches a
 * skill, so every native discovery field remains `not-observed`.
 *
 * Usage:
 *   node tools/verify-selected-content.mjs --source ABSOLUTE_ECC_SOURCE --output ABSOLUTE_EMPTY_DIR
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CLIENTS = ["claude", "codex", "cursor", "kimi", "kiro", "opencode"];
const PATH_PREFIXES = {
  claude: ".claude/skills/",
  codex: ".agents/skills/",
  cursor: ".cursor/skills/",
  kimi: ".kimi-code/skills/",
  kiro: ".kiro/skills/",
  opencode: ".agents/skills/",
};

function fail(message) {
  throw new Error(`verify-selected-content: ${message}`);
}

function parseArgs(argv) {
  let source;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") source = argv[++index];
    else if (flag === "--output") output = argv[++index];
    else if (flag === "--help") {
      process.stdout.write("Usage: node tools/verify-selected-content.mjs --source ABSOLUTE_ECC_SOURCE --output ABSOLUTE_EMPTY_DIR\n");
      process.exit(0);
    } else fail(`unexpected argument: ${flag}`);
  }
  if (typeof source !== "string" || !isAbsolute(source)) fail("--source must be absolute");
  if (typeof output !== "string" || !isAbsolute(output)) fail("--output must be absolute");
  return { source: resolve(source), output: resolve(output) };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function receiptRows(root, project) {
  const receipt = project.initialReceipt;
  if (receipt?.format !== "aih-ecc-materialization-receipt") fail(`${root} has no initial materialization receipt`);
  const component = receipt.components?.[0];
  if (!component?.authorization?.pinnedSha || !component?.provenance?.repository) {
    fail(`${root} receipt does not identify its qualified source`);
  }
  const targets = new Set(component.targets);
  return CLIENTS.map((client) => {
    const paths = component.files
      .map((file) => file.path)
      .filter((path) => path.startsWith(PATH_PREFIXES[client]));
    const sharedPaths = component.files
      .map((file) => file.path)
      .filter((path) => path.startsWith(".agents/skills/"));
    const selected = targets.has(client);
    // Codex and OpenCode discover the canonical project `.agents` projection.
    // Kimi retains a client projection in addition to the same shared path.
    const materializedPaths = ["codex", "opencode"].includes(client) ? sharedPaths : paths;
    if (selected && materializedPaths.length === 0) fail(`${client} has no selected owned discovery path`);
    return {
      client,
      projectId: project.projectId,
      selection: selected ? "required" : "not-selected",
      component: component.id,
      source: { repository: component.provenance.repository, commit: component.provenance.commit },
      receiptOwnedPaths: materializedPaths,
      physicalFilesObserved: "not-observed-after-lifecycle-mutations",
      nativeDiscovery: "not-observed",
      enabledEntries: null,
      duplicateExposures: null,
      nativeOutputBytes: null,
      discoveryDurationMs: null,
      billing: null,
      provider: "not-launched",
      cache: "not-applicable",
      limitation: "This receipt row proves public CLI materialization ownership only; run a client-specific normal-launch probe before asserting discovery or loaded content.",
    };
  });
}

function main() {
  const { source, output } = parseArgs(process.argv.slice(2));
  if (existsSync(output)) fail("--output must not already exist");
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail("--source must be a readable source directory");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const delivery = join(output, "public-cli-lifecycle");
  const run = spawnSync(process.execPath, ["tools/verify-policy-delivery.mjs", "--source", source, "--output", delivery, "--retain-active-roots"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true,
  });
  const report = {
    schemaVersion: 1,
    purpose: "selected ECC content public lifecycle and discovery contract",
    publicCli: { command: "tools/verify-policy-delivery.mjs", exitCode: run.status, providerSimulation: "gh attestation verify only" },
    nativeClaim: "No native client was launched by this verifier. Receipt paths are not native catalog rows.",
    rows: [],
    status: "failed",
  };
  try {
    if (run.status !== 0) fail(`public lifecycle failed: ${run.stderr || run.stdout}`);
    const result = JSON.parse(readFileSync(join(delivery, "RESULT.json"), "utf8"));
    if (result.status !== "passed") fail("public lifecycle result was not passed");
    const cedar = result.roots?.Cedar;
    if (!cedar) fail("public lifecycle did not produce the six-client Cedar adopter");
    report.rows = receiptRows("Cedar", cedar);
    if (report.rows.filter((row) => row.selection === "required").length !== CLIENTS.length) {
      fail("Cedar did not retain all six governed targets");
    }
    report.source = result.source;
    report.projects = [{ projectId: cedar.projectId, context: "Cedar fictional security service" }];
    report.activeNativeRoots = result.retainedNativeRoots ?? null;
    report.status = "passed";
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  }
  writeJson(join(output, "RESULT.json"), report);
  if (report.status !== "passed") process.exitCode = 1;
}

main();
