/**
 * Continue the governed delivery lifecycle from a preserved successful public
 * CLI fixture. This records recovery after clean uninstall, stale-binding
 * refusal before target expansion, empty-selection withdrawal convergence,
 * and drifted-uninstall recovery.
 *
 * Usage:
 *   node tools/verify-policy-delivery-lifecycle-extension.mjs \
 *     --attempt ABSOLUTE_PUBLIC_CLI_ATTEMPT \
 *     --output ABSOLUTE_EMPTY_DIR
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const PIN = "5064474d4d762dc9640234a41617cccb79185cec";
const MATERIALIZATION_RECEIPT = ".aih/ecc/materialization-v1.json";
const GUIDANCE = "ai-coding/policy-required-guidance.md";
const GUIDANCE_RECEIPT = "ai-coding/policy-required-guidance.receipt.json";

function fail(message) {
  throw new Error(`policy-delivery-lifecycle-extension: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseArgs(argv) {
  let attempt;
  let output;
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--attempt") attempt = argv[++index];
    else if (flag === "--output") output = argv[++index];
    else if (flag === "--resume") resume = true;
    else if (flag === "--help") {
      process.stdout.write(
        "Usage: node tools/verify-policy-delivery-lifecycle-extension.mjs --attempt ABSOLUTE_PUBLIC_CLI_ATTEMPT --output ABSOLUTE_EMPTY_DIR\n",
      );
      process.exit(0);
    } else fail(`unexpected argument: ${flag}`);
  }
  if (typeof attempt !== "string" || !isAbsolute(attempt)) fail("--attempt must be absolute");
  if (typeof output !== "string" || !isAbsolute(output)) fail("--output must be absolute");
  return { attempt: realpathSync(attempt), output: resolve(output), resume };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function replacePolicy(root, mutate) {
  const path = join(root, "aih-org-policy.json");
  const value = readJson(path);
  mutate(value);
  writeJson(path, value);
  return value;
}

function snapshot(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[name] = sha256(readFileSync(path));
      else fail(`fixture contains unsupported filesystem entry: ${name}`);
    }
  };
  visit(root);
  return files;
}

function git(root, args, result, label, { input } = {}) {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: input === undefined ? "utf8" : undefined,
    input,
    windowsHide: true,
    timeout: 30_000,
  });
  result.fixtureCommands.push({
    label,
    root,
    args,
    exitCode: run.status,
    stdout: Buffer.isBuffer(run.stdout) ? `<${run.stdout.byteLength} bytes>` : run.stdout,
    stderr: Buffer.isBuffer(run.stderr) ? run.stderr.toString("utf8") : run.stderr,
  });
  assert(run.status === 0, `${label} failed: ${Buffer.isBuffer(run.stderr) ? run.stderr.toString("utf8") : run.stderr}`);
  return run;
}

function commitAll(root, label, result) {
  const status = git(root, ["status", "--porcelain"], result, `${label}: inspect`).stdout;
  if (status.trim() === "") return;
  git(root, ["add", "-A"], result, `${label}: stage`);
  git(root, ["commit", "-qm", label], result, `${label}: commit`);
}

function cleanEnvironment(bin) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "AIH_ORG_POLICY")),
    PATH: `${bin};${process.env.PATH ?? ""}`,
    Path: `${bin};${process.env.Path ?? process.env.PATH ?? ""}`,
    PATHEXT: ".EXE;.CMD;.BAT",
  };
}

function runCli(cli, bin, root, args, result, label, expectSuccess = true) {
  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    env: cleanEnvironment(bin),
  });
  result.commands.push({
    label,
    root,
    args,
    startedAt,
    exitCode: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
  });
  if (expectSuccess) assert(run.status === 0, `${label} failed: ${run.stderr || run.stdout}`);
  return run;
}

function rebind(cli, bin, root, project, targets, result) {
  return runCli(
    cli,
    bin,
    root,
    [
      "policy",
      "rebind",
      "--root",
      root,
      "--policy",
      join(root, "aih-org-policy.json"),
      "--project",
      project,
      "--cli",
      targets,
      "--apply",
      "--json",
      "--no-log",
    ],
    result,
    `rebind ${project} to ${targets}`,
  );
}

function project(cli, source, bin, root, targets, result, label, expectSuccess = true) {
  return runCli(
    cli,
    bin,
    root,
    [
      "policy",
      "project",
      "--root",
      root,
      "--posture",
      "enterprise",
      "--cli",
      targets,
      "--ecc-path",
      source,
      "--apply",
      "--json",
      "--no-log",
    ],
    result,
    label,
    expectSuccess,
  );
}

function uninstall(cli, bin, root, result, label) {
  return runCli(
    cli,
    bin,
    root,
    ["uninstall", root, "--apply", "--force", "--json", "--no-log"],
    result,
    label,
  );
}

function receipt(root) {
  const path = join(root, ...MATERIALIZATION_RECEIPT.split("/"));
  assert(existsSync(path), `materialization receipt is absent in ${root}`);
  return readJson(path);
}

function component(root, id) {
  const selected = receipt(root).components?.find((entry) => entry.id === id);
  assert(selected, `materialization receipt does not contain ${id}`);
  assert(Array.isArray(selected.files) && selected.files.length > 0, `${id} has no owned files`);
  return selected;
}

function binding(root) {
  const marker = readJson(join(root, ".aih-config.json"));
  assert(marker.policyBinding, `policy binding is absent in ${root}`);
  return marker.policyBinding;
}

function main() {
  const { attempt, output, resume } = parseArgs(process.argv.slice(2));
  if (existsSync(output) && !resume) fail("--output must not already exist");
  assert(lstatSync(attempt).isDirectory(), "--attempt is not a directory");
  mkdirSync(output, { recursive: true });

  const prior = readJson(join(attempt, "RESULT.json"));
  const source = realpathSync(prior.source?.root);
  assert(prior.status === "passed", "preserved public CLI attempt did not pass");
  assert(prior.source?.head === PIN && prior.source?.pin === PIN, "preserved attempt used an unexpected ECC pin");
  assert(lstatSync(source).isDirectory(), "preserved exact ECC source is unavailable");
  const bin = join(attempt, "attestation-bin");
  assert(lstatSync(bin).isDirectory(), "preserved isolated attestation simulator is unavailable");
  const cli = resolve("dist/cli.js");
  assert(existsSync(cli), "dist/cli.js is absent");

  const harbor = realpathSync(join(attempt, "Harbor"));
  const cedar = realpathSync(join(attempt, "Cedar"));
  const result = resume
    ? readJson(join(output, "RESULT.json"))
    : {
        schemaVersion: 1,
        purpose: "public CLI policy delivery lifecycle extension",
        preservedAttempt: attempt,
        source: { root: source, pin: PIN },
        simulatedService: "gh attestation verify only",
        fixtureCommands: [],
        commands: [],
        checks: {},
        status: "failed",
      };
  if (resume) {
    assert(result.status === "failed", "--resume requires a prior failed harness result");
    result.resumedAfterHarnessAssertion = true;
    delete result.failure;
  }

  try {
    let expanded;
    let expandedPolicy;
    let staleAttempt;
    if (resume) {
      expandedPolicy = readJson(join(harbor, "aih-org-policy.json"));
      assert(
        expandedPolicy.governance?.policyVersion === "fictional-lane4-delivery-v3",
        "resumed Harbor policy is not the reviewed target expansion",
      );
      assert(binding(harbor).state === "active", "resumed Harbor binding is not active");
      expanded = component(harbor, "skill:tdd-workflow");
      staleAttempt = [...result.commands]
        .reverse()
        .find((command) => command.label === "refuse target expansion under stale binding");
      assert(staleAttempt?.exitCode !== 0, "prior stale-binding refusal is absent from resumed evidence");
    } else {
      assert(binding(harbor).state === "revoked", "Harbor did not begin with a revoked binding");
      assert(!existsSync(join(harbor, ...MATERIALIZATION_RECEIPT.split("/"))), "Harbor retained its ECC receipt");
      commitAll(harbor, "record clean governed uninstall", result);
      const recoveryPolicy = readJson(join(harbor, "aih-org-policy.json"));
      assert(
        recoveryPolicy.governance?.policyVersion === "fictional-lane4-delivery-v2",
        "Harbor reviewed recovery policy did not carry the expected version bump",
      );
      rebind(cli, bin, harbor, "harbor-node-api", "codex", result);
      project(cli, source, bin, harbor, "codex", result, "recover Harbor after clean uninstall");
      const recovered = component(harbor, "skill:tdd-workflow");
      assert(recovered.targets?.join(",") === "codex", "Harbor recovery did not restore Codex-only ownership");
      assert(binding(harbor).state === "active", "Harbor recovery did not reactivate the reviewed binding");
      commitAll(harbor, "recover governed delivery", result);
      result.checks.cleanUninstallRecovery = {
        passed: true,
        policyVersion: recoveryPolicy.governance.policyVersion,
        targets: recovered.targets,
        files: recovered.files.map((file) => file.path),
      };

      expandedPolicy = replacePolicy(harbor, (value) => {
        value.governance.policyVersion = "fictional-lane4-delivery-v3";
      });
      commitAll(harbor, "review Codex and OpenCode delivery", result);
      const beforeStaleAttempt = snapshot(harbor);
      const staleRun = project(
        cli,
        source,
        bin,
        harbor,
        "codex,opencode",
        result,
        "refuse target expansion under stale binding",
        false,
      );
      assert(staleRun.status !== 0, "stale binding unexpectedly authorized target expansion");
      assert(
        JSON.stringify(snapshot(harbor)) === JSON.stringify(beforeStaleAttempt),
        "stale-binding refusal changed Harbor",
      );
      staleAttempt = { exitCode: staleRun.status };
      rebind(cli, bin, harbor, "harbor-node-api", "codex,opencode", result);
      project(cli, source, bin, harbor, "codex,opencode", result, "deliver reviewed target expansion");
      expanded = component(harbor, "skill:tdd-workflow");
    }
    assert(
      JSON.stringify([...expanded.targets].sort()) === JSON.stringify(["codex", "opencode"]),
      "expanded delivery receipt does not cover Codex and OpenCode",
    );
    for (const file of expanded.files) {
      assert(existsSync(join(harbor, ...file.path.split("/"))), `expanded delivery is missing ${file.path}`);
    }
    commitAll(harbor, "deliver Codex and OpenCode policy", result);
    result.checks.targetExpansion = {
      passed: true,
      policyVersion: expandedPolicy.governance.policyVersion,
      staleBindingExitCode: staleAttempt.exitCode,
      staleBindingWasEffectFree: true,
      targets: expanded.targets,
    };

    const withdrawnPolicy = replacePolicy(harbor, (value) => {
      value.governance.policyVersion = "fictional-lane4-delivery-v4";
      value.governance.externalSelections = [{ framework: "ecc", items: [] }];
    });
    commitAll(harbor, "review empty ECC selection", result);
    rebind(cli, bin, harbor, "harbor-node-api", "codex,opencode", result);
    project(cli, source, bin, harbor, "codex,opencode", result, "withdraw governed ECC selection");
    assert(!existsSync(join(harbor, ...MATERIALIZATION_RECEIPT.split("/"))), "withdrawal retained ECC receipt");
    assert(!existsSync(join(harbor, ...GUIDANCE.split("/"))), "withdrawal retained required guidance");
    assert(!existsSync(join(harbor, ...GUIDANCE_RECEIPT.split("/"))), "withdrawal retained guidance receipt");
    for (const file of expanded.files) {
      assert(!existsSync(join(harbor, ...file.path.split("/"))), `withdrawal retained ${file.path}`);
    }
    const beforeRepeatWithdrawal = snapshot(harbor);
    project(cli, source, bin, harbor, "codex,opencode", result, "repeat empty-selection convergence");
    assert(
      JSON.stringify(snapshot(harbor)) === JSON.stringify(beforeRepeatWithdrawal),
      "repeat empty-selection projection changed Harbor",
    );
    result.checks.emptySelectionWithdrawal = {
      passed: true,
      policyVersion: withdrawnPolicy.governance.policyVersion,
      receiptRemoved: true,
      guidanceRemoved: true,
      repeatedProjectionWasEffectFree: true,
    };

    assert(binding(cedar).state === "revoked", "Cedar did not begin with a revoked binding");
    const retained = component(cedar, "skill:security-review");
    assert(retained.files.length === 1, "Cedar did not retain exactly one drifted owned file");
    const drifted = retained.files[0];
    const driftedPath = join(cedar, ...drifted.path.split("/"));
    const currentDigest = sha256(readFileSync(driftedPath));
    assert(currentDigest !== drifted.contentSha256, "Cedar retained file is not drifted");
    const restored = git(
      cedar,
      ["show", `HEAD:${drifted.path}`],
      result,
      "read reviewed Cedar bytes from Git HEAD",
      { input: undefined },
    ).stdout;
    const restoredBytes = Buffer.from(restored, "utf8");
    assert(
      sha256(restoredBytes) === drifted.contentSha256,
      "Git HEAD bytes do not match the retained receipt SHA256",
    );
    writeFileSync(driftedPath, restoredBytes);
    assert(sha256(readFileSync(driftedPath)) === drifted.contentSha256, "Cedar exact-byte restoration failed");
    uninstall(cli, bin, cedar, result, "retry Cedar uninstall after exact-byte recovery");
    assert(!existsSync(join(cedar, ...MATERIALIZATION_RECEIPT.split("/"))), "Cedar uninstall retry retained ECC receipt");
    assert(!existsSync(driftedPath), "Cedar uninstall retry retained the recovered owned file");
    assert(binding(cedar).state === "revoked", "Cedar uninstall retry changed revoked binding state");
    assert(readFileSync(join(cedar, "notes", "OPERATOR.md"), "utf8") === "Cedar operator content\n", "Cedar operator file changed");
    result.checks.driftRecoveryAndUninstallRetry = {
      passed: true,
      path: drifted.path,
      driftedSha256: currentDigest,
      receiptSha256: drifted.contentSha256,
      restoredFrom: `HEAD:${drifted.path}`,
      receiptRemoved: true,
      revokedBindingRetained: true,
    };

    result.status = "passed";
  } catch (error) {
    result.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  }

  writeJson(join(output, "RESULT.json"), result);
  process.stdout.write(`${JSON.stringify({ status: result.status, output: join(output, "RESULT.json") })}\n`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}

main();
