import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorMcpPolicyViaPackedWorkbench } from "./lib/author-mcp-policy-via-workbench.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !existsSync(npmCli))
  throw new Error("cold-mcp-npm-cli-unavailable");
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const legacyPolicy = option("--legacy-policy");
const evidenceDir = option("--evidence-dir");
const TARGETS = ["claude", "codex", "cursor", "copilot", "opencode", "kimi", "kiro"];
const PATHS = {
  claude: ".claude/managed-settings.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/mcp.json",
  copilot: ".github/mcp.json",
  opencode: "opencode.json",
  kimi: ".kimi-code/mcp.json",
  kiro: ".kiro/settings/mcp.json",
};
const SERVERS = ["sequential-thinking", "code-review-graph"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const tempBase = realpathSync(resolve(tmpdir()));
const temp = realpathSync(mkdtempSync(join(tempBase, "aih-governed-mcp-cold-")));
const evidence = {
  format: "aih-cold-governed-mcp-proof",
  version: 1,
  timestamp: new Date().toISOString(),
  checks: [],
  limitations: [
    "Generated MCP server commands were never executed.",
    "Protected-file verification is exercised; operating-system ACL enforcement is outside this proof.",
  ],
};
const environment = {
  ...process.env,
  HOME: join(temp, "home"),
  USERPROFILE: join(temp, "home"),
};
for (const key of Object.keys(environment)) if (key.startsWith("AIH_")) delete environment[key];
const emit = (name, data = {}) => {
  const outcome =
    data.outcome ?? (data.exitCode === undefined || data.exitCode === 0 ? "pass" : "blocked");
  evidence.checks.push({ name, ...data, outcome });
  process.stdout.write(`${name}: ${outcome}\n`);
};

function run(cwd, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...environment, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  assert(
    result.error === undefined && result.status !== null,
    "cold-mcp-child-process-incomplete",
  );
  return result;
}

function jsonOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

/** Retain typed diagnostics and counts only; never private messages, ids, paths or content. */
function diagnosticSummary(result) {
  const parsed = jsonOutput(result);
  const codes = new Set();
  const verdicts = {};
  let candidates = 0;
  let effectiveCandidates = 0;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/u.test(value.code))
      codes.add(value.code);
    if (["pass", "fail", "skip", "warn"].includes(value.verdict))
      verdicts[value.verdict] = (verdicts[value.verdict] ?? 0) + 1;
    if (Array.isArray(value.candidates)) {
      candidates += value.candidates.length;
      effectiveCandidates += value.candidates.filter((item) => item.effective === true).length;
    }
    for (const child of Object.values(value)) if (typeof child === "object") visit(child);
  };
  visit(parsed);
  return {
    exitCode: result.status,
    codes: [...codes].sort(),
    verdicts,
    candidates,
    effectiveCandidates,
    outputDigest: sha256(`${result.stdout}\n${result.stderr}`),
  };
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
function settingsSnapshot(target) {
  return Object.fromEntries(
    Object.entries(PATHS).map(([host, path]) => [
      host,
      existsSync(join(target, path)) ? sha256(readFileSync(join(target, path))) : null,
    ]),
  );
}
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeCleanup(path) {
  const resolved = resolve(path);
  assert(
    resolved.startsWith(`${tempBase}${sep}`) && resolved === temp,
    "cold-mcp-cleanup-outside-owned-fixture",
  );
  assert(
    !lstatSync(resolved).isSymbolicLink() && realpathSync(resolved) === temp,
    "cold-mcp-cleanup-linked-root",
  );
  // Node removes symlink entries without traversing their targets. Verify every
  // traversed directory stays inside this exact fixture before recursive removal.
  const inspect = (directory) => {
    assert(
      realpathSync(directory).startsWith(`${temp}${sep}`) || directory === temp,
      "cold-mcp-cleanup-linked-parent",
    );
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory() && !item.isSymbolicLink()) inspect(join(directory, item.name));
    }
  };
  inspect(resolved);
  rmSync(resolved, { recursive: true, force: true });
}

try {
  const packed = run(root, [npmCli, "pack", "--json", "--pack-destination", temp]);
  assert(packed.status === 0, "cold-mcp-pack-failed");
  const manifest = jsonOutput(packed)?.[0];
  assert(
    manifest?.name === "@aihq/core" &&
      typeof manifest.filename === "string" &&
      !manifest.filename.includes("/") &&
      !manifest.filename.includes("\\"),
    "cold-mcp-pack-manifest-invalid",
  );
  const consumer = join(temp, "consumer");
  const target = join(temp, "target");
  const admin = join(temp, "admin");
  for (const directory of [consumer, target, admin]) mkdirSync(directory);
  write(join(consumer, "package.json"), '{"name":"cold-governed-mcp","private":true}');
  const installed = run(consumer, [
    npmCli,
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    join(temp, manifest.filename),
  ]);
  assert(installed.status === 0, "cold-mcp-install-failed");
  const packageRoot = join(consumer, "node_modules", "@aihq", "core");
  const cli = join(packageRoot, "dist", "cli.js");
  const core = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
  const invoke = (cwd, args, policyPath) =>
    run(
      cwd,
      [cli, ...args, "--json"],
      policyPath === undefined ? {} : { AIH_ORG_POLICY: policyPath },
    );
  emit("packed-install", {
    version: manifest.version,
    archiveDigest: sha256(readFileSync(join(temp, manifest.filename))),
  });

  const htmlPath = join(admin, "aih-policy-workbench.html");
  const generated = invoke(admin, ["policy", "generate", "--apply", "--out", htmlPath]);
  assert(
    generated.status === 0 && existsSync(htmlPath),
    "cold-mcp-workbench-generation-failed",
  );
  const policy = await authorMcpPolicyViaPackedWorkbench({
    htmlPath,
    targets: TARGETS,
    servers: SERVERS,
  });
  emit("packed-workbench-mcp-authoring", {
    schemaVersion: policy.schemaVersion,
    targets: TARGETS.length,
    candidates: policy.governance.catalog.reviewed.length,
  });

  // The protected Workbench requires one Decision V2 to export its authority
  // envelope. This inert fixture tool is never activated. MCP admission uses
  // only the packed, exact built-in catalog evidence from the selected policy.
  const now = new Date();
  const authorityPath = join(admin, "policy-bundle.json");
  const authorityFields = {
    "protected-bundle-version": "cold-mcp-1",
    "protected-issued-at": now.toISOString(),
    "protected-expires-at": new Date(now.getTime() + 86400000).toISOString(),
    "protected-issuer": "cold-fixture-admin",
    "protected-issuer-repository": "example.invalid/cold-mcp",
    "protected-kind": "tool",
    "protected-subject-id": "cold-inert-tool",
    "protected-source-type": "aih",
    "protected-source-release": manifest.version,
    "protected-source-revision": `sha256:${"a".repeat(64)}`,
    "protected-targets": TARGETS.join(","),
    "protected-effects": "observe",
    "protected-decision-id": "decision-cold-inert-tool",
    "protected-evidence-id": "cold-inert-evidence",
    "protected-evidence-digest": `sha256:${"b".repeat(64)}`,
    "protected-attestor": "cold-fixture-attestor",
    "protected-policy-id": "cold-fixture-policy",
    "protected-policy-version": "1",
    "protected-policy-digest": `sha256:${"c".repeat(64)}`,
    "protected-control-id": "cold-inert-control",
    "protected-control-digest": `sha256:${"d".repeat(64)}`,
    "protected-actor": "fixture-admin@example.invalid",
    "protected-reason":
      "Inert disposable authority-envelope fixture; no tool activation or execution is requested.",
  };
  const bundle = await authorMcpPolicyViaPackedWorkbench({
    htmlPath,
    targets: TARGETS,
    servers: SERVERS,
    authorityFields,
  });
  assert(core.parsePolicyBundle(bundle).ok, "cold-mcp-protected-bundle-invalid");
  write(authorityPath, JSON.stringify(bundle, null, 2));
  const validate = invoke(target, ["policy", "validate"], authorityPath);
  emit("protected-policy-validation", diagnosticSummary(validate));
  assert(validate.status === 0, "cold-mcp-protected-validation-failed");

  for (const [host, path] of Object.entries(PATHS)) {
    write(
      join(target, path),
      host === "codex"
        ? '# operator-owned setting\nmodel = "operator-model"\n'
        : '{"operator":true}\n',
    );
  }
  const projectArgs = ["policy", "project", "--cli", TARGETS.join(","), "--apply"];
  const initial = invoke(target, projectArgs, authorityPath);
  emit("all-seven-projection", diagnosticSummary(initial));
  assert(initial.status === 0, "cold-mcp-all-seven-projection-failed");
  for (const path of Object.values(PATHS)) {
    const text = readFileSync(join(target, path), "utf8");
    assert(
      SERVERS.every((server) => text.includes(server)),
      "cold-mcp-host-projection-missing-server",
    );
    assert(text.includes("operator"), "cold-mcp-user-setting-lost");
  }
  const markerPath = join(target, ".aih-config.json");
  const receipt = JSON.parse(readFileSync(markerPath, "utf8"));
  assert(
    Object.keys(receipt.nativeMcpProjections ?? {}).length === 5 &&
      receipt.managedMcpProjection &&
      receipt.kiroMcpProjection,
    "cold-mcp-host-receipt-missing",
  );
  const projectedSnapshot = settingsSnapshot(target);
  const markerDigest = sha256(readFileSync(markerPath));
  const second = invoke(target, projectArgs, authorityPath);
  assert(
    second.status === 0 &&
      same(projectedSnapshot, settingsSnapshot(target)) &&
      markerDigest === sha256(readFileSync(markerPath)),
    "cold-mcp-idempotency-failed",
  );
  emit("idempotent-second-projection", { unchangedHosts: 7 });

  const limitedTargets = TARGETS.filter((host) => host !== "copilot");
  const limitedAuthority = await authorMcpPolicyViaPackedWorkbench({
    htmlPath,
    targets: limitedTargets,
    servers: SERVERS,
    authorityFields: { ...authorityFields, "protected-targets": limitedTargets.join(",") },
  });
  const limitedTarget = join(temp, "limited-target");
  mkdirSync(limitedTarget);
  const limitedPath = join(admin, "limited-policy-bundle.json");
  write(limitedPath, JSON.stringify(limitedAuthority, null, 2));
  const limitedInitial = invoke(
    limitedTarget,
    ["policy", "project", "--cli", limitedTargets.join(","), "--apply"],
    limitedPath,
  );
  assert(
    limitedInitial.status === 0 && !existsSync(join(limitedTarget, PATHS.copilot)),
    "cold-mcp-limited-authority-setup-failed",
  );
  const limitedSnapshot = settingsSnapshot(limitedTarget);
  // Clean shipped controls are sanctioned by the complete protected policy.
  // Requesting another known host must not expand that unchanged authority.
  const protectedDigest = sha256(readFileSync(limitedPath));
  const expansionEvaluation = invoke(
    limitedTarget,
    ["policy", "evaluate", "--posture", "enterprise", "--cli", TARGETS.join(",")],
    limitedPath,
  );
  const expansion = invoke(limitedTarget, projectArgs, limitedPath);
  const expansionRefused =
    same(limitedSnapshot, settingsSnapshot(limitedTarget)) &&
    !existsSync(join(limitedTarget, PATHS.copilot)) &&
    protectedDigest === sha256(readFileSync(limitedPath));
  emit("unauthorized-target-expansion", {
    ...diagnosticSummary(expansion),
    outcome: expansionRefused ? "blocked" : "unexpected-success",
    authorityVersion: limitedAuthority.authorityReceipt.version,
    authorityTargets: limitedAuthority.authorityReceipt.targets,
    policyTargets: limitedAuthority.policy.governance.supportedClis,
    requestedTargets: TARGETS,
    protectedBundleDigest: protectedDigest,
    copilotCreated: existsSync(join(limitedTarget, PATHS.copilot)),
    evaluation: diagnosticSummary(expansionEvaluation),
  });
  if (!expansionRefused) evidence.failures = ["cold-mcp-unauthorized-expansion-accepted"];

  const changedPath = join(target, PATHS.cursor);
  const original = readFileSync(changedPath, "utf8");
  write(changedPath, original.replace("uvx", "operator-uvx"));
  const changedSnapshot = settingsSnapshot(target);
  const drift = invoke(target, projectArgs, authorityPath);
  assert(
    drift.status !== 0 && same(changedSnapshot, settingsSnapshot(target)),
    "cold-mcp-drift-not-refused",
  );
  emit("operator-drift-refused", diagnosticSummary(drift));
  write(changedPath, original);

  const kept = TARGETS.filter((host) => host !== "cursor");
  const narrowed = await authorMcpPolicyViaPackedWorkbench({
    htmlPath,
    targets: kept,
    servers: SERVERS,
    authorityFields: {
      ...authorityFields,
      "protected-bundle-version": "cold-mcp-2",
      "protected-targets": kept.join(","),
    },
  });
  write(authorityPath, JSON.stringify(narrowed, null, 2));
  const explicitRemoval = invoke(target, projectArgs, authorityPath);
  emit("removed-target-explicit-reconciliation", diagnosticSummary(explicitRemoval));
  const removal = invoke(
    target,
    ["policy", "project", "--cli", kept.join(","), "--apply"],
    authorityPath,
  );
  emit("narrowed-policy-projection", {
    ...diagnosticSummary(removal),
    command: ["aih", "policy", "project", "--cli", kept.join(","), "--apply", "--json"],
  });
  assert(removal.status === 0, "cold-mcp-target-removal-failed");
  let removalMethod = "explicit-policy-reconciliation";
  if (SERVERS.some((server) => readFileSync(changedPath, "utf8").includes(server))) {
    // Prune's documented removal authority is committed marker intent plus the
    // unchanged receipt, never a temporary --cli selection or missing binary.
    const committed = JSON.parse(readFileSync(markerPath, "utf8"));
    write(markerPath, JSON.stringify({ ...committed, targets: kept }, null, 2));
    const pruned = invoke(target, ["prune", "--apply"], authorityPath);
    emit("committed-target-prune", {
      ...diagnosticSummary(pruned),
      command: ["aih", "prune", "--apply", "--json"],
      committedMarkerTargetCount: kept.length,
    });
    assert(pruned.status === 0, "cold-mcp-committed-target-prune-failed");
    removalMethod = "prune-after-committed-target-edit";
  }
  const removed = readFileSync(changedPath, "utf8");
  const remainingServers = SERVERS.filter((server) => removed.includes(server));
  const receiptRetained = Boolean(
    JSON.parse(readFileSync(markerPath, "utf8")).nativeMcpProjections?.cursor,
  );
  emit("one-target-removal-state", {
    removalMethod,
    remainingServerCount: remainingServers.length,
    operatorPreserved: removed.includes("operator"),
    receiptRetained,
    outcome: remainingServers.length === 0 && !receiptRetained ? "pass" : "retained",
  });
  if (remainingServers.length > 0 || receiptRetained || !removed.includes("operator"))
    evidence.failures = [...(evidence.failures ?? []), "cold-mcp-target-removal-retained"];
  const afterRemovalMarker = JSON.parse(readFileSync(markerPath, "utf8"));
  const ownedMcp = (marker, host) =>
    host === "claude"
      ? marker.managedMcpProjection?.expected
      : host === "kiro"
        ? marker.kiroMcpProjection?.expected
        : marker.nativeMcpProjections?.[host]?.expected;
  for (const host of kept) {
    assert(
      same(ownedMcp(receipt, host), ownedMcp(afterRemovalMarker, host)),
      "cold-mcp-target-removal-changed-kept-mcp",
    );
    // Claude's separate organizationPolicy keys legitimately reflect the new
    // sanctioned target set; its receipt-owned MCP pair must remain unchanged.
    if (host !== "claude")
      assert(
        settingsSnapshot(target)[host] === projectedSnapshot[host],
        "cold-mcp-target-removal-changed-kept-host",
      );
    assert(
      readFileSync(join(target, PATHS[host]), "utf8").includes("operator"),
      "cold-mcp-target-removal-lost-operator-setting",
    );
  }
  emit("retained-target-mcp-preserved", { targets: kept.length });

  if (legacyPolicy !== undefined) {
    assert(
      isAbsolute(legacyPolicy) &&
        lstatSync(legacyPolicy).isFile() &&
        !lstatSync(legacyPolicy).isSymbolicLink(),
      "cold-mcp-legacy-policy-not-regular",
    );
    const privateBytes = readFileSync(legacyPolicy);
    const privateDigest = sha256(privateBytes);
    const privatePolicy = JSON.parse(privateBytes.toString("utf8"));
    const legacyTarget = join(temp, "legacy-target");
    mkdirSync(legacyTarget);
    const privateWorkbench = join(admin, "private-workbench.html");
    const reopened = invoke(admin, [
      "policy",
      "generate",
      "--policy-input",
      legacyPolicy,
      "--out",
      privateWorkbench,
      "--apply",
    ]);
    emit("legacy-private-policy-reopen", {
      ...diagnosticSummary(reopened),
      generatedOutputBytes: existsSync(privateWorkbench)
        ? readFileSync(privateWorkbench).byteLength
        : 0,
    });
    const validation = invoke(legacyTarget, ["policy", "validate"], legacyPolicy);
    const requestedTargets = [
      ...new Set(
        (privatePolicy.governance?.activations ?? [])
          .filter((activation) => activation.state === "active")
          .flatMap((activation) => activation.targets),
      ),
    ].filter((host) => TARGETS.includes(host));
    const selectionArgs =
      requestedTargets.length === 0 ? [] : ["--cli", requestedTargets.join(",")];
    const evaluation = invoke(
      legacyTarget,
      ["policy", "evaluate", "--posture", "enterprise", ...selectionArgs],
      legacyPolicy,
    );
    assert(
      sha256(readFileSync(legacyPolicy)) === privateDigest,
      "cold-mcp-private-policy-mutated",
    );
    emit("legacy-private-policy-validation", {
      schemaVersion: privatePolicy.schemaVersion,
      policyDigest: privateDigest,
      reviewedCandidateCount: privatePolicy.governance?.catalog?.reviewed?.length ?? 0,
      customCandidateCount: privatePolicy.governance?.catalog?.custom?.length ?? 0,
      approvalCount: privatePolicy.governance?.authority?.approvals?.length ?? 0,
      requestedMcpCount: privatePolicy.governance?.aihMcpRequests?.length ?? 0,
      ...diagnosticSummary(validation),
    });
    emit("legacy-private-policy-evaluation", diagnosticSummary(evaluation));
    const application = invoke(
      legacyTarget,
      ["policy", "project", ...selectionArgs, "--apply"],
      legacyPolicy,
    );
    emit("legacy-private-policy-apply", {
      ...diagnosticSummary(application),
      command: ["aih", "policy", "project", ...selectionArgs, "--apply", "--json"],
      mutationSourceRefused:
        jsonOutput(application)?.error?.message?.includes(
          "configuration mutation requires the committed default policy or a trusted managed channel",
        ) === true,
    });
    const observedLegacyMcp = settingsSnapshot(legacyTarget);
    const newTargetMcpCount = TARGETS.filter(
      (host) => host !== "claude" && host !== "kiro",
    ).filter((host) => observedLegacyMcp[host] !== null).length;
    assert(newTargetMcpCount === 0, "cold-mcp-legacy-policy-scope-expanded");
    const postApply = invoke(
      legacyTarget,
      ["policy", "evaluate", "--posture", "enterprise", ...selectionArgs],
      legacyPolicy,
    );
    emit("legacy-private-policy-post-apply-evaluation", diagnosticSummary(postApply));
    assert(
      sha256(readFileSync(legacyPolicy)) === privateDigest,
      "cold-mcp-private-policy-mutated",
    );
    emit("legacy-private-policy-scope-preserved", {
      policyUnchanged: true,
      authorityFabricated: false,
      newTargetMcpCount,
      originalTargetMcpCount: ["claude", "kiro"].filter(
        (host) => observedLegacyMcp[host] !== null,
      ).length,
      hookConfigurationCount: [".claude/settings.json", ".codex/hooks.json"].filter((path) =>
        existsSync(join(legacyTarget, path)),
      ).length,
    });
    assert(validation.status === 0, "cold-mcp-legacy-policy-compatibility-failed");
  }
  evidence.outcome = evidence.failures?.length ? "failed" : "pass";
  if (evidence.outcome === "failed") process.exitCode = 1;
} catch (error) {
  evidence.outcome = "failed";
  evidence.failure =
    error instanceof Error && /^cold-mcp-[a-z0-9-]+$/u.test(error.message)
      ? error.message
      : "cold-mcp-proof-error";
  process.exitCode = 1;
  process.stderr.write(`${evidence.failure}\n`);
} finally {
  try {
    if (evidenceDir !== undefined) {
      assert(isAbsolute(evidenceDir), "cold-mcp-evidence-dir-not-absolute");
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "packed-governed-mcp-proof.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
  } finally {
    safeCleanup(temp);
  }
}
