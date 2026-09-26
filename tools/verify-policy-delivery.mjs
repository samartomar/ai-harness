/**
 * Disposable, public-CLI acceptance for governed ECC policy delivery.
 *
 * It deliberately runs the published `dist/cli.js` command against two new
 * consumer roots. The only simulated service is `gh attestation verify`,
 * supplied as a process on PATH; policy parsing, evidence checksum handling,
 * source hashing, target projection, receipts, reconciliation, and removal are
 * all performed by the product command.
 *
 * Usage:
 *   node tools/verify-policy-delivery.mjs --source ABSOLUTE_ECC_CHECKOUT --output ABSOLUTE_EMPTY_DIR
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const TARGETS = ["claude", "codex", "cursor", "opencode", "kimi", "kiro"];
const PIN = "5064474d4d762dc9640234a41617cccb79185cec";
const COMPONENTS = {
  tdd: { id: "skill:tdd-workflow", path: ".agents/skills/tdd-workflow" },
  frontend: { id: "skill:frontend-patterns", path: ".agents/skills/frontend-patterns" },
  security: { id: "skill:security-review", path: ".agents/skills/security-review" },
  verification: { id: "skill:verification-loop", path: "skills/verification-loop" },
};

function fail(message) {
  throw new Error(`portable-policy-delivery: ${message}`);
}

function parseArgs(argv) {
  let source;
  let output;
  let retainActiveRoots = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") source = argv[++index];
    else if (flag === "--output") output = argv[++index];
    else if (flag === "--retain-active-roots") retainActiveRoots = true;
    else if (flag === "--help") {
      process.stdout.write("Usage: node tools/verify-policy-delivery.mjs --source ABSOLUTE_ECC_CHECKOUT --output ABSOLUTE_EMPTY_DIR [--retain-active-roots]\n");
      process.exit(0);
    } else fail("expected --source and --output");
  }
  if (typeof source !== "string" || !isAbsolute(source)) fail("--source must be absolute");
  if (typeof output !== "string" || !isAbsolute(output)) fail("--output must be absolute");
  return { source: realpathSync(source), output: resolve(output), retainActiveRoots };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commitPolicy(root, label) {
  for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "AIH Fixture"], ["add", "aih-org-policy.json"], ["commit", "-qm", label]]) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assertion(run.status === 0, `could not commit policy: ${run.stderr}`);
  }
}

function commitDelivery(root, label) {
  for (const args of [["add", "-A"], ["commit", "-qm", label]]) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assertion(run.status === 0, `could not commit governed delivery: ${run.stderr}`);
  }
}

function tree(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[name] = sha256(readFileSync(path));
    }
  };
  visit(root);
  return result;
}

function assertion(condition, message) {
  if (!condition) fail(message);
}

function sourceHead(source) {
  const result = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0) fail("source checkout does not expose a readable Git HEAD");
  const head = result.stdout.trim();
  if (head !== PIN) fail(`source HEAD ${head || "(empty)"} does not equal catalog pin ${PIN}`);
  return head;
}

function policy(items) {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "fictional-adopter/project.json" },
    governance: {
      supportedClis: TARGETS,
      policyVersion: "fictional-lane4-delivery-v1",
      catalog: { reviewed: [], custom: [] },
      externalSelections: [
        {
          framework: "ecc",
          items: items.map((item) => ({
            kind: "skill",
            id: item.id,
            source: { repository: "affaan-m/ECC", commit: PIN, path: item.path },
          })),
        },
      ],
    },
    trust: {
      baselineOverrides: [
        {
          catalog: "ecc",
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: PIN,
          bundle: ".aih/org-evidence/ecc",
          signingRepository: "fictional-adopter/governance",
          reason: "deterministic acceptance bundle",
          reviewer: "fictional administrator",
          approvedAt: "2026-09-13T00:00:00.000Z",
        },
      ],
    },
  };
}

function seedEvidence(root) {
  const descriptor = JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve("@aihq/catalog/catalog-framework-ecc.json"),
      "utf8",
    ),
  );
  const lock = Buffer.from(descriptor.sections.vendorLockDocument.bytesBase64, "base64");
  const artifact = ".aih/baseline-reports/ecc.json";
  const digest = sha256(lock);
  const manifest = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, files: [{ path: artifact, bytes: lock.byteLength, sha256: digest }] }, null, 2)}\n`,
  );
  const index = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, artifacts: [{ kind: "baseline-evidence", path: artifact, sha256: digest, schemaVersion: 1 }] }, null, 2)}\n`,
  );
  const bundle = join(root, ".aih/org-evidence/ecc");
  write(join(bundle, "files", artifact), lock);
  write(join(bundle, "manifest.json"), manifest);
  write(join(bundle, "evidence.json"), index);
  write(
    join(bundle, "SHA256SUMS"),
    `${digest}  files/${artifact}\n${sha256(manifest)}  manifest.json\n${sha256(index)}  evidence.json\n`,
  );
}

function fakeAttestation(bin) {
  if (process.platform !== "win32") fail("this acceptance harness currently records Windows public CLI delivery");
  const source = join(bin, "gh.cs");
  const executable = join(bin, "gh.exe");
  write(
    source,
    "using System; public static class Gh { public static int Main(string[] args) { if (args.Length < 2 || args[0] != \"attestation\" || args[1] != \"verify\") return 64; Console.WriteLine(\"synthetic external attestation accepted\"); return 0; } }\n",
  );
  const compiler = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const compiled = spawnSync(compiler, ["/nologo", `/out:${executable}`, source], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assertion(compiled.status === 0 && existsSync(executable), "could not prepare the isolated attestation simulator");
}

function invoke(cli, source, bin, root, target, action, result, { expectSuccess = true, force = false } = {}) {
  const args = [
    cli,
    "ecc",
    root,
    "--posture",
    "enterprise",
    "--cli",
    target,
    "--ecc-path",
    source,
    "--lifecycle",
    "install",
    "--apply",
    "--json",
    "--no-log",
  ];
  if (action === "uninstall")
    args.splice(1, args.length - 1, "uninstall", root, "--apply", ...(force ? ["--force"] : []), "--json", "--no-log");
  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AIH_ORG_POLICY")),
      PATH: `${bin};${process.env.PATH ?? ""}`,
      Path: `${bin};${process.env.Path ?? process.env.PATH ?? ""}`,
      PATHEXT: ".EXE;.CMD;.BAT",
    },
  });
  result.commands.push({ action, root, target, args: args.slice(1), startedAt, exitCode: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr });
  if (expectSuccess) assertion(run.status === 0, `${action} failed for ${target}: ${run.stderr || run.stdout}`);
  return run;
}

function bind(cli, bin, root, project, target, rebind, result) {
  const args = [cli, "policy", rebind ? "rebind" : "bind", "--root", root, "--policy", join(root, "aih-org-policy.json"), "--project", project, "--cli", target, "--apply", "--json", "--no-log"];
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AIH_ORG_POLICY")), PATH: `${bin};${process.env.PATH ?? ""}`, Path: `${bin};${process.env.Path ?? process.env.PATH ?? ""}` } });
  result.commands.push({ action: rebind ? "rebind" : "bind", root, target, args: args.slice(1), exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
  assertion(run.status === 0, `${rebind ? "rebind" : "bind"} failed: ${run.stderr || run.stdout}`);
}

function receipt(root) {
  const path = join(root, ".aih/ecc/materialization-v1.json");
  assertion(existsSync(path), "materialization receipt is absent");
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertComponent(root, component) {
  const record = receipt(root);
  const selected = record.components?.find((entry) => entry.id === component.id);
  assertion(selected !== undefined, `receipt does not retain ${component.id}`);
  assertion(Array.isArray(selected.files) && selected.files.length > 0, `${component.id} has no receipt-owned files`);
  for (const file of selected.files) {
    assertion(existsSync(join(root, ...file.path.split("/"))), `missing materialized ${file.path}`);
  }
  return selected;
}

function assertExcluded(root, component, adopter) {
  assertion(
    !receipt(root).components?.some((entry) => entry.id === component.id),
    `${adopter} retained explicitly excluded ${component.id}`,
  );
}

function recordStructuredRefusals(run, result) {
  if (typeof run.stdout !== "string" || run.stdout.trim() === "") return;
  let payload;
  try {
    payload = JSON.parse(run.stdout);
  } catch {
    return;
  }
  for (const digest of payload.digests ?? []) {
    for (const refusal of digest?.data?.refused ?? []) {
      if (
        result.acceptanceFailures.some(
          (entry) => entry.target === refusal.target && entry.component === refusal.id && entry.reason === refusal.reason,
        )
      )
        continue;
      result.acceptanceFailures.push({
        stage: "governed ECC materialization",
        target: refusal.target,
        component: refusal.id,
        reason: refusal.reason,
        detail: refusal.detail,
      });
    }
  }
}

function main() {
  const { source, output, retainActiveRoots } = parseArgs(process.argv.slice(2));
  if (existsSync(output)) fail("--output must not already exist");
  if (!lstatSync(source).isDirectory()) fail("--source is not a directory");
  const sourceHeadValue = sourceHead(source);
  mkdirSync(output, { recursive: true });
  const bin = join(output, "attestation-bin");
  mkdirSync(bin);
  fakeAttestation(bin);
  const result = {
    schemaVersion: 1,
    purpose: "public-dist-cli governed ECC delivery lifecycle",
    source: { root: source, head: sourceHeadValue, pin: PIN },
    simulatedService: "gh attestation verify only",
    commands: [],
    roots: {},
    blockedTargets: [],
    acceptanceFailures: [],
    status: "failed",
  };
  try {
    const cli = resolve("dist/cli.js");
    assertion(existsSync(cli), "published dist/cli.js is absent; run npm run build first");
    const kiroProbe = join(output, "Kiro-authorization");
    mkdirSync(kiroProbe);
    write(join(kiroProbe, "notes", "OPERATOR.md"), "Kiro authorization probe operator content\n");
    seedEvidence(kiroProbe);
    writeJson(join(kiroProbe, "aih-org-policy.json"), policy([COMPONENTS.security]));
    const kiroRun = invoke(cli, source, bin, kiroProbe, "kiro", "install", result, { expectSuccess: false });
    const kiroOutput = `${kiroRun.stderr ?? ""}${kiroRun.stdout ?? ""}`;
    const cedarTargets =
      kiroRun.status === 0
        ? TARGETS
        : (() => {
            const kiroReason = kiroOutput.includes(
              "governed Kiro materialization refused: runtime Kiro tree does not match its authorization",
            )
              ? "runtime Kiro tree does not match its authorization"
              : kiroOutput.includes("governed Kiro materialization refused: skill provenance does not match the selected component")
                ? "skill provenance does not match the selected component"
                : null;
            assertion(kiroReason, `Kiro failed for an unclassified reason: ${kiroOutput}`);
            result.blockedTargets.push({
              target: "kiro",
              stage: "governed ECC materialization",
              reason: kiroReason,
              commandIndex: result.commands.length - 1,
            });
            result.acceptanceFailures.push({
              stage: "governed ECC materialization",
              target: "kiro",
              reason: kiroReason,
            });
            return TARGETS.filter((target) => target !== "kiro");
          })();
    if (kiroRun.status === 0) assertComponent(kiroProbe, COMPONENTS.security);
    for (const [name, project, target, items, excluded] of [
      ["Harbor", "harbor-node-api", "codex", [COMPONENTS.tdd], COMPONENTS.frontend],
      ["Cedar", "cedar-security-service", cedarTargets.join(","), [COMPONENTS.security], COMPONENTS.tdd],
    ]) {
      const root = join(output, name);
      mkdirSync(root);
      write(join(root, "notes", "OPERATOR.md"), `${name} operator content\n`);
      seedEvidence(root);
      writeJson(join(root, "aih-org-policy.json"), policy(items));
      commitPolicy(root, "bind policy");
      bind(cli, bin, root, project, target, false, result);
      const initial = invoke(cli, source, bin, root, target, "install", result);
      recordStructuredRefusals(initial, result);
      assertComponent(root, items[0]);
      assertExcluded(root, excluded, name);
      const beforeRepeat = tree(root);
      const repeated = invoke(cli, source, bin, root, target, "install", result);
      recordStructuredRefusals(repeated, result);
      assertion(JSON.stringify(tree(root)) === JSON.stringify(beforeRepeat), `${name} repeated install changed owned state`);
      commitDelivery(root, "initial governed delivery");
      result.roots[name] = { root, initialTargets: target, required: items[0].id, excluded: excluded.id, initialReceipt: receipt(root) };
    }

    // Native probes require a disposable root whose ordinary public-CLI setup
    // is still active. Preserve it before the default lifecycle below walks
    // update, withdrawal, and uninstall on the original roots.
    if (retainActiveRoots) {
      const nativeRoots = join(output, "native-active-roots");
      mkdirSync(nativeRoots);
      result.retainedNativeRoots = {};
      for (const name of ["Harbor", "Cedar"]) {
        const retained = join(nativeRoots, name);
        cpSync(result.roots[name].root, retained, { recursive: true, errorOnExist: true });
        result.retainedNativeRoots[name] = {
          root: retained,
          source: "public CLI setup after repeat-convergence, before lifecycle update/uninstall",
          lifecycleStatus: "active retained copy; original fixture continues complete lifecycle",
        };
      }
    }

    const a = result.roots.Harbor.root;
    replaceJson(join(a, "aih-org-policy.json"), policy([COMPONENTS.tdd, COMPONENTS.verification]));
    commitPolicy(a, "add verification");
    bind(cli, bin, a, "harbor-node-api", "codex", true, result);
    recordStructuredRefusals(invoke(cli, source, bin, a, "codex", "install", result), result);
    assertComponent(a, COMPONENTS.verification);
    commitDelivery(a, "add verification delivery");
    replaceJson(join(a, "aih-org-policy.json"), policy([COMPONENTS.tdd]));
    commitPolicy(a, "remove verification");
    bind(cli, bin, a, "harbor-node-api", "codex", true, result);
    recordStructuredRefusals(invoke(cli, source, bin, a, "codex", "install", result), result);
    assertion(!receipt(a).components?.some((entry) => entry.id === COMPONENTS.verification.id), "selection removal retained verification-loop ownership");
    commitDelivery(a, "remove verification delivery");

    const b = result.roots.Cedar.root;
    bind(cli, bin, b, "cedar-security-service", "codex", true, result);
    recordStructuredRefusals(invoke(cli, source, bin, b, "codex", "install", result), result);
    commitDelivery(b, "retarget Cedar delivery");
    result.roots.Cedar.reconciledTargets = receipt(b).targets;
    const clean = assertComponent(a, COMPONENTS.tdd);
    invoke(cli, source, bin, a, "codex", "uninstall", result);
    for (const file of clean.files) assertion(!existsSync(join(a, ...file.path.split("/"))), `clean uninstall retained ${file.path}`);
    assertion(readFileSync(join(a, "notes", "OPERATOR.md"), "utf8") === "Harbor operator content\n", "clean uninstall changed operator content");

    const drift = assertComponent(b, COMPONENTS.security).files[0];
    writeFileSync(join(b, ...drift.path.split("/")), "operator-modified owned guidance\n", "utf8");
    const driftedUninstall = invoke(cli, source, bin, b, "codex", "uninstall", result, { expectSuccess: false, force: true });
    assertion(driftedUninstall.status !== 0, "drifted uninstall unexpectedly reported success");
    assertion(
      /failpartial|drift|refus/i.test(`${driftedUninstall.stdout ?? ""}${driftedUninstall.stderr ?? ""}`),
      "drifted uninstall did not report the partial/refused outcome",
    );
    assertion(readFileSync(join(b, ...drift.path.split("/")), "utf8") === "operator-modified owned guidance\n", "drifted owned file was overwritten or deleted");
    assertion(readFileSync(join(b, "notes", "OPERATOR.md"), "utf8") === "Cedar operator content\n", "drift uninstall changed operator content");

    assertion(
      result.acceptanceFailures.length === 0,
      `advertised target materialization refused: ${JSON.stringify(result.acceptanceFailures)}`,
    );
    result.status = "passed";
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  }
  writeJson(join(output, "RESULT.json"), result);
  process.stdout.write(`${JSON.stringify({ status: result.status, output: join(output, "RESULT.json") })}\n`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}

main();
