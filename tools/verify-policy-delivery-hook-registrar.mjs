/**
 * Disposable public-CLI acceptance for the Claude third-party hook registrar.
 *
 * The policy is administrator-authored input. AIH validates and binds it,
 * projects the exact third-party launcher without executing it, reconciles the
 * stable owned state, and later withdraws only that owned hook. A rich
 * unrelated hook added after registration must survive withdrawal unchanged.
 *
 * Usage:
 *   node tools/verify-policy-delivery-hook-registrar.mjs --output ABSOLUTE_EMPTY_DIR
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(sourceRoot, "dist", "cli.js");
const receiptPath = ".aih/org-policy-hook-registrar-receipt.json";
const settingsPath = ".claude/settings.json";
const launcher =
  "node -e \"require('~/.claude/scripts/hooks/run-with-flags.js').run('session-summary.js')\"";
const unrelatedHook = {
  matcher: "startup-only",
  description: "operator-owned lifecycle witness",
  hooks: [
    {
      type: "command",
      command: "node unrelated-hook.js",
      timeout: 9,
      async: true,
    },
  ],
};

function fail(message) {
  throw new Error(`policy-delivery-hook-registrar: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--output") output = argv[++index];
    else if (flag === "--help") {
      process.stdout.write(
        "Usage: node tools/verify-policy-delivery-hook-registrar.mjs --output ABSOLUTE_EMPTY_DIR\n",
      );
      process.exit(0);
    } else fail("expected --output");
  }
  if (typeof output !== "string" || !isAbsolute(output)) fail("--output must be absolute");
  return resolve(output);
}

function policy(version, registrations) {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "fictional-adopter/project.json" },
    governance: {
      policyVersion: version,
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      externalSelections: [{ framework: "ecc", items: [] }],
      hookRegistrations: registrations,
    },
  };
}

function thirdPartyRegistration() {
  return {
    id: "ecc-stop-session-summary",
    event: "Stop",
    command: launcher,
    functionTags: ["ecc-stop-session-summary"],
    spawns: 3,
    owner: {
      kind: "third-party",
      framework: "ecc",
      declaredControls: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
      pin: {
        repository: "affaan-m/ECC",
        commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
        path: "scripts/hooks/session-summary.js",
        launcherSha256: `sha256:${sha256(launcher)}`,
        runtimeVersion: "3.7.1",
      },
    },
  };
}

function git(root, args) {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert(run.status === 0, `git ${args.join(" ")} failed: ${run.stderr || run.stdout}`);
}

function commit(root, label) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", label]);
}

function snapshot(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        result[relative(root, path).replaceAll("\\", "/")] = sha256(readFileSync(path));
      }
    }
  };
  visit(root);
  return result;
}

function invoke(root, args, result, expectSuccess = true) {
  const env = { ...process.env };
  delete env.AIH_ORG_POLICY;
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 120_000,
  });
  result.commands.push({ args, exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
  if (expectSuccess) {
    assert(run.status === 0, `${args.slice(0, 2).join(" ")} failed: ${run.stderr || run.stdout}`);
  }
  return run;
}

function settings(root) {
  return JSON.parse(readFileSync(join(root, settingsPath), "utf8"));
}

function flattenEvent(value, event) {
  return (value.hooks?.[event] ?? []).flatMap((group) => group.hooks ?? []);
}

function main() {
  const output = parseArgs(process.argv.slice(2));
  assert(!existsSync(output), "--output must not already exist");
  assert(existsSync(cli), "dist/cli.js is missing; build the public artifact first");
  mkdirSync(output, { recursive: true });
  const target = join(output, "HookRegistrar");
  mkdirSync(join(target, "fictional-adopter"), { recursive: true });
  const policyPath = join(target, "aih-org-policy.json");
  const activePolicy = policy("lane4-hook-registrar-v1", [thirdPartyRegistration()]);
  const withdrawnPolicy = policy("lane4-hook-registrar-v2", []);
  const result = {
    schemaVersion: 1,
    purpose: "public dist CLI Claude third-party hook registrar lifecycle",
    target,
    externalSimulation: "none",
    thirdPartyLauncherExecuted: false,
    commands: [],
    status: "failed",
  };

  try {
    writeJson(join(target, "fictional-adopter", "project.json"), {
      name: "hook-registrar-consumer",
    });
    writeJson(join(target, settingsPath), { operatorPreference: "preserve-me" });
    writeJson(policyPath, activePolicy);
    writeJson(join(output, "AUTHORED_POLICY_ACTIVE.json"), activePolicy);
    writeJson(join(output, "AUTHORED_POLICY_WITHDRAWN.json"), withdrawnPolicy);
    git(target, ["init", "-q"]);
    git(target, ["config", "user.email", "fixture@example.invalid"]);
    git(target, ["config", "user.name", "AIH Hook Registrar Fixture"]);
    commit(target, "administrator-authored hook policy");

    invoke(
      target,
      ["policy", "validate", target, "--posture", "enterprise", "--json", "--no-log"],
      result,
    );
    invoke(
      target,
      [
        "policy",
        "bind",
        target,
        "--project",
        "hook-registrar-consumer",
        "--cli",
        "claude",
        "--policy",
        policyPath,
        "--apply",
        "--json",
        "--no-log",
      ],
      result,
    );
    commit(target, "bind exact reviewed hook policy");

    const beforePreview = snapshot(target);
    invoke(
      target,
      ["policy", "project", target, "--posture", "enterprise", "--json", "--no-log"],
      result,
    );
    assert(stable(snapshot(target)) === stable(beforePreview), "registration preview wrote files");
    assert(!existsSync(join(target, receiptPath)), "registration preview wrote receipt");

    invoke(
      target,
      [
        "policy",
        "project",
        target,
        "--posture",
        "enterprise",
        "--apply",
        "--json",
        "--no-log",
      ],
      result,
    );
    const activeSettings = settings(target);
    const selectedHooks = flattenEvent(activeSettings, "Stop");
    assert(
      selectedHooks.some((hook) => hook.type === "command" && hook.command === launcher),
      "exact third-party launcher was not registered",
    );
    assert(activeSettings.operatorPreference === "preserve-me", "operator setting was changed");
    assert(existsSync(join(target, receiptPath)), "registrar receipt missing after projection");
    writeJson(join(output, "SETTINGS_AFTER_REGISTRATION.json"), activeSettings);
    write(join(output, "RECEIPT_AFTER_REGISTRATION.json"), readFileSync(join(target, receiptPath)));
    commit(target, "public hook registration");

    const beforeReconcile = snapshot(target);
    invoke(
      target,
      [
        "policy",
        "project",
        target,
        "--posture",
        "enterprise",
        "--apply",
        "--json",
        "--no-log",
      ],
      result,
    );
    assert(stable(snapshot(target)) === stable(beforeReconcile), "stable reconcile changed files");

    const withUnrelated = settings(target);
    withUnrelated.hooks.SessionStart = [structuredClone(unrelatedHook)];
    writeJson(join(target, settingsPath), withUnrelated);
    const unrelatedBefore = stable(withUnrelated.hooks.SessionStart[0]);
    writeJson(join(output, "SETTINGS_BEFORE_WITHDRAWAL.json"), withUnrelated);
    writeJson(policyPath, withdrawnPolicy);
    commit(target, "administrator withdraws owned hook and operator adds unrelated hook");
    invoke(
      target,
      ["policy", "validate", target, "--posture", "enterprise", "--json", "--no-log"],
      result,
    );
    invoke(
      target,
      [
        "policy",
        "rebind",
        target,
        "--project",
        "hook-registrar-consumer",
        "--cli",
        "claude",
        "--apply",
        "--json",
        "--no-log",
      ],
      result,
    );
    commit(target, "bind reviewed hook withdrawal");

    const beforeWithdrawalPreview = snapshot(target);
    invoke(
      target,
      ["policy", "project", target, "--posture", "enterprise", "--json", "--no-log"],
      result,
    );
    assert(
      stable(snapshot(target)) === stable(beforeWithdrawalPreview),
      "withdrawal preview wrote files",
    );
    invoke(
      target,
      [
        "policy",
        "project",
        target,
        "--posture",
        "enterprise",
        "--apply",
        "--json",
        "--no-log",
      ],
      result,
    );
    const afterWithdrawal = settings(target);
    assert(flattenEvent(afterWithdrawal, "Stop").length === 0, "owned Stop hook survived withdrawal");
    assert(
      stable(afterWithdrawal.hooks?.SessionStart?.[0]) === unrelatedBefore,
      "unrelated SessionStart hook changed during withdrawal",
    );
    assert(
      afterWithdrawal.operatorPreference === "preserve-me",
      "operator setting changed during withdrawal",
    );
    assert(!existsSync(join(target, receiptPath)), "active registrar receipt survived withdrawal");
    writeJson(join(output, "SETTINGS_AFTER_WITHDRAWAL.json"), afterWithdrawal);
    result.assertions = {
      activeLauncherExact: true,
      activeReceiptPresent: true,
      previewsWereEffectFree: true,
      stableReconcileWasIdempotent: true,
      ownedHookWithdrawn: true,
      unrelatedHookPreservedExactly: true,
      operatorSettingPreserved: true,
    };
    result.status = "passed";
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  }

  writeJson(join(output, "RESULT.json"), result);
  process.stdout.write(`${JSON.stringify({ status: result.status, output: join(output, "RESULT.json") })}\n`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}

main();
