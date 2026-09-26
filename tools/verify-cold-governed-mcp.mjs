import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMcpPolicyFixture } from "./lib/build-mcp-policy-fixture.mjs";

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
const SERVERS = ["sequential-thinking"];
const DRIFTED_SERVER = "code-review-graph";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SERVER_SHAPES = {
  "code-review-graph": {
    type: "stdio",
    command: "uvx",
    args: ["--offline", "--no-python-downloads", "--no-env-file", "code-review-graph@2.3.7", "serve"],
    env: {},
    classification: "local",
    egress: "none",
    credentials: "none",
    supplyChain: "pinned",
  },
  "sequential-thinking": {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.8.31"],
    env: {},
    classification: "local",
    egress: "none",
    credentials: "none",
    supplyChain: "pinned",
  },
};
function stable(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function reviewedServer(id) {
  const server = SERVER_SHAPES[id];
  assert(server !== undefined, "cold-mcp-server-fixture-missing");
  const { type, command, args, env, classification, egress, credentials, supplyChain } = server;
  const subject = `mcp-server-sha256:${sha256(
    stable({
      shape: { type, command, args, env },
      risk: { classification, egress, credentials, supplyChain, skillsProvider: undefined },
    }),
  )}`;
  return {
    id,
    kind: "mcp",
    description: "Disposable exact-pinned AIH-owned MCP fixture",
    capabilities: [],
    risks: [],
    source: { type: "mcp", server: id, subject },
    targets: TARGETS,
    projector: "mcp-managed-settings",
    lifecycle: "supported",
    evidence: { record: `cold-mcp-${id}` },
  };
}
function basePolicy(targets, servers = SERVERS) {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    mcp: { allowManagedOnly: true, allowedServers: [], disabledServers: [] },
    governance: {
      policyVersion: "cold-mcp-1",
      supportedClis: targets,
      catalog: { reviewed: servers.map(reviewedServer), custom: [] },
      activations: servers.map((candidate) => ({ candidate, state: "active", targets })),
      authority: { approvals: [] },
    },
  };
}
function authorityReceipt(targets, now) {
  return {
    format: "aih-policy-authority-receipt",
    version: 3,
    issuerRepository: "example.invalid/cold-mcp",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    trustedIssuers: [{ id: "cold-fixture-admin", githubRepository: "example.invalid/cold-mcp" }],
    targets: [...targets].sort(),
    decisions: [],
    decisionRevocations: [],
  };
}
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
    "Positive code-review-graph projection is not proven; its old generic identity is checked only for fail-closed refusal.",
    "Protected-file verification is exercised; operating-system ACL enforcement is outside this proof.",
  ],
};
let packedArchivePath;
const environment = {
  ...process.env,
  HOME: join(temp, "home"),
  USERPROFILE: join(temp, "home"),
  APPDATA: join(temp, "home", "AppData", "Roaming"),
  LOCALAPPDATA: join(temp, "home", "AppData", "Local"),
  XDG_CONFIG_HOME: join(temp, "home", ".config"),
  XDG_CACHE_HOME: join(temp, "home", ".cache"),
  XDG_DATA_HOME: join(temp, "home", ".local", "share"),
  XDG_STATE_HOME: join(temp, "home", ".local", "state"),
  XDG_RUNTIME_DIR: join(temp, "home", ".runtime"),
};
if (process.platform === "win32") {
  environment.HOMEDRIVE = environment.HOME.slice(0, 2);
  environment.HOMEPATH = environment.HOME.slice(2);
}
for (const key of Object.keys(environment)) if (/^AIH_/iu.test(key)) delete environment[key];
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
  packedArchivePath = join(temp, manifest.filename);
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
  const installedRoot = realpathSync(packageRoot);
  assert(
    installedRoot.startsWith(`${realpathSync(consumer)}${sep}`),
    "cold-mcp-installed-package-outside-consumer",
  );
  const cli = join(packageRoot, "dist", "cli.js");
  const installedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const exportedEntry = installedManifest.exports?.["."]?.import;
  assert(
    installedManifest.name === "@aihq/core" &&
      typeof exportedEntry === "string" &&
      exportedEntry.startsWith("./dist/"),
    "cold-mcp-public-core-export-invalid",
  );
  const publicEntry = resolve(packageRoot, exportedEntry);
  assert(
    realpathSync(publicEntry).startsWith(`${installedRoot}${sep}`),
    "cold-mcp-public-core-entry-outside-install",
  );
  const core = await import(pathToFileURL(publicEntry).href);
  const invoke = (cwd, args, policyPath) =>
    run(
      cwd,
      [cli, ...args, "--json"],
      policyPath === undefined ? {} : { AIH_ORG_POLICY: policyPath },
    );
  emit("packed-install", {
    version: manifest.version,
    archiveDigest: sha256(readFileSync(packedArchivePath)),
    publicEntry: publicEntry.slice(consumer.length + 1).replaceAll("\\", "/"),
  });

  // The old generic CRG pin is not the root-aware native CRG identity in
  // current Core. Preserve it as an explicit fail-closed, zero-write check;
  // a separate positive seven-host fixture uses the unchanged exact
  // sequential-thinking server, never a relabeled positive CRG result.
  const driftTarget = join(temp, "identity-drift-target");
  mkdirSync(driftTarget);
  for (const [host, path] of Object.entries(PATHS)) {
    write(
      join(driftTarget, path),
      host === "codex"
        ? '# operator-owned setting\nmodel = "operator-model"\n'
        : '{"operator":true}\n',
    );
  }
  const driftBefore = settingsSnapshot(driftTarget);
  const driftedPolicyPath = join(admin, "identity-drift-policy.json");
  const driftedBundle = buildMcpPolicyFixture({
    core,
    basePolicy: basePolicy(TARGETS, [DRIFTED_SERVER]),
    targets: TARGETS,
    servers: [DRIFTED_SERVER],
    authorityReceipt: authorityReceipt(TARGETS, new Date()),
  });
  write(driftedPolicyPath, JSON.stringify(driftedBundle, null, 2));
  const driftedProjection = invoke(
    driftTarget,
    ["policy", "project", "--cli", TARGETS.join(","), "--apply"],
    driftedPolicyPath,
  );
  const driftedMessage = jsonOutput(driftedProjection)?.error?.message;
  assert(
    driftedProjection.status !== 0 &&
      typeof driftedMessage === "string" &&
      driftedMessage.includes("runtime-mcp-identity-mismatch") &&
      same(driftBefore, settingsSnapshot(driftTarget)) &&
      !existsSync(join(driftTarget, ".aih-config.json")),
    "cold-mcp-crg-identity-drift-not-refused",
  );
  emit("crg-identity-drift-refused", {
    ...diagnosticSummary(driftedProjection),
    outcome: "expected-refusal",
    unchangedHosts: 7,
    positiveCrgProven: false,
  });

  // The fixture declares exact pinned built-in controls. The installed Core
  // parser and CLI decide whether those claims are still valid; no private
  // catalog compiler or browser authoring path is loaded by this cold proof.
  const policy = buildMcpPolicyFixture({
    core,
    basePolicy: basePolicy(TARGETS),
    targets: TARGETS,
    servers: SERVERS,
  });
  emit("headless-mcp-policy-fixture", {
    schemaVersion: policy.schemaVersion,
    targets: TARGETS.length,
    candidates: policy.governance.catalog.reviewed.length,
  });

  // This exact V3 receipt bounds targets but asserts no Decision V2 approval.
  // The selected built-in controls must pass Core's own clean-control checks.
  const now = new Date();
  const authorityPath = join(admin, "policy-bundle.json");
  const bundle = buildMcpPolicyFixture({
    core,
    basePolicy: basePolicy(TARGETS),
    targets: TARGETS,
    servers: SERVERS,
    authorityReceipt: authorityReceipt(TARGETS, now),
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
  const initialRefusal = jsonOutput(initial)?.error?.message;
  emit("all-seven-sequential-projection", {
    ...diagnosticSummary(initial),
    server: "sequential-thinking",
    // This first command uses only the generated disposable policy. Keep a
    // bounded diagnostic without the temporary absolute path; later private
    // policy checks still retain codes and counts only.
    generatedFixtureRefusal:
      initial.status !== 0 && typeof initialRefusal === "string"
        ? initialRefusal.replaceAll(temp, "<disposable>").slice(0, 500)
        : undefined,
  });
  assert(initial.status === 0, "cold-mcp-all-seven-sequential-projection-failed");
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
  const limitedAuthority = buildMcpPolicyFixture({
    core,
    basePolicy: basePolicy(limitedTargets),
    targets: limitedTargets,
    servers: SERVERS,
    authorityReceipt: authorityReceipt(limitedTargets, now),
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
  // Requesting another known host must not expand the unchanged authority.
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
  write(changedPath, original.replace("npx", "operator-npx"));
  const changedSnapshot = settingsSnapshot(target);
  const drift = invoke(target, projectArgs, authorityPath);
  assert(
    drift.status !== 0 && same(changedSnapshot, settingsSnapshot(target)),
    "cold-mcp-drift-not-refused",
  );
  emit("operator-drift-refused", diagnosticSummary(drift));
  write(changedPath, original);

  const kept = TARGETS.filter((host) => host !== "cursor");
  const narrowedPolicy = basePolicy(kept);
  narrowedPolicy.governance.policyVersion = "cold-mcp-2";
  const narrowed = buildMcpPolicyFixture({
    core,
    basePolicy: narrowedPolicy,
    targets: kept,
    servers: SERVERS,
    authorityReceipt: authorityReceipt(kept, now),
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
      assert(!existsSync(evidenceDir), "cold-mcp-evidence-dir-already-exists");
      mkdirSync(evidenceDir);
      if (packedArchivePath !== undefined && existsSync(packedArchivePath)) {
        const archiveName = basename(packedArchivePath);
        copyFileSync(packedArchivePath, join(evidenceDir, archiveName));
        evidence.preservedArchive = {
          file: archiveName,
          sha256: sha256(readFileSync(packedArchivePath)),
        };
      }
      writeFileSync(
        join(evidenceDir, "packed-governed-mcp-proof.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
  } finally {
    safeCleanup(temp);
  }
}
