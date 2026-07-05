import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enterpriseBaselineAttestationCheck } from "../baseline/attestation.js";
import { type Posture, resolvePosture } from "../config/posture.js";
import type { PlanContext } from "../internals/plan.js";
import type { Runner } from "../internals/proc.js";
import type { Check } from "../internals/verify.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import { makeHostAdapter } from "../platform/detect.js";
import { scanConfigSecrets, scanSecrets } from "../secrets/scan.js";
import { MAX_VERIFICATION_STRING_FIELD_LENGTH } from "./constants.js";
import { VerificationRegistry } from "./registry.js";
import type {
  Evidence,
  Severity,
  Verdict,
  VerificationCategory,
  VerificationInput,
  VerificationPass,
  VerificationResult,
} from "./types.js";

export const STRUCTURED_VERIFICATION_PASS_NAMES = [
  "exec-locality",
  "policy",
  "security",
  "dependency",
  "doc-consistency",
] as const;

type StructuredPassName = (typeof STRUCTURED_VERIFICATION_PASS_NAMES)[number];

const PACKAGE_JSON = "package.json";
const RULE_ROUTER_FILE = "RULE_ROUTER.md";
const PROJECT_FILE = "project.md";
const EVIDENCE_FIELD_MAX = 512;
const REMOTE_FETCH_COMMAND = "(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)";
const REMOTE_EXEC_COMMAND = "(?:sh|bash|zsh|dash|ksh|fish|powershell|pwsh|iex|invoke-expression)";
const EXEC_PATH_PREFIX = "(?:/(?:[A-Za-z0-9._-]+/)*)?";
const REMOTE_PIPE_EXEC_RE = new RegExp(
  `\\b${REMOTE_FETCH_COMMAND}\\b[^\\r\\n;&]*\\|\\s*` +
    `(?:(?:${EXEC_PATH_PREFIX}(?:sudo|command))\\b\\s+(?:-[A-Za-z0-9-]+\\s+)*|` +
    `(?:${EXEC_PATH_PREFIX}env)\\b\\s+(?:(?:-[A-Za-z0-9-]+|[A-Za-z_][A-Za-z0-9_]*=\\S+)\\s+)*|` +
    `(?:${EXEC_PATH_PREFIX}xargs)\\b\\s+(?:-[A-Za-z0-9-]+\\s+)*)*` +
    `${EXEC_PATH_PREFIX}${REMOTE_EXEC_COMMAND}\\b`,
  "i",
);
const REMOTE_PROCESS_SUBSTITUTION_RE = new RegExp(
  `\\b${REMOTE_EXEC_COMMAND}\\b[^\\r\\n;&|]*<\\(\\s*${REMOTE_FETCH_COMMAND}\\b`,
  "i",
);
const POWERSHELL_REMOTE_INVOKE_RE = new RegExp(
  `\\b(?:iex|invoke-expression)\\b[^\\r\\n;&|]*\\(\\s*${REMOTE_FETCH_COMMAND}\\b`,
  "i",
);
const STRUCTURED_VERIFICATION_RUNNER: Runner = async () => ({
  code: 127,
  stdout: "",
  stderr: "structured verification passes do not execute local tools",
  spawnError: true,
});

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function truncateWithHash(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = `-${shortHash(value)}`;
  let head = Array.from(value)
    .slice(0, maxLength - suffix.length)
    .join("");
  while (head.length + suffix.length > maxLength) head = head.slice(0, -1);
  return `${head}${suffix}`;
}

function appendHash(value: string, original: string, maxLength: number): string {
  const suffix = `-${shortHash(original)}`;
  if (value.length + suffix.length <= maxLength) return `${value}${suffix}`;
  let head = Array.from(value)
    .slice(0, maxLength - suffix.length)
    .join("");
  while (head.length + suffix.length > maxLength) head = head.slice(0, -1);
  return `${head}${suffix}`;
}

function boundedMessage(value: string): string {
  return truncateWithHash(
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: verification messages must stay parser-safe
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .trim(),
    MAX_VERIFICATION_STRING_FIELD_LENGTH,
  );
}

function evidenceField(value: string): string {
  const canonical = value.replace(/\\/g, "/");
  const normalized = value
    .replace(/\\/g, "/")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: evidence IDs/sources must not carry terminal controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "-")
    .replace(/[^A-Za-z0-9._:@/#-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = normalized.length > 0 ? normalized : "value";
  if (normalized !== canonical) return appendHash(base, value, EVIDENCE_FIELD_MAX);
  return truncateWithHash(base, EVIDENCE_FIELD_MAX);
}

function evidence(id: string, type: string, source: string): Evidence {
  return { id: evidenceField(id), type: evidenceField(type), source: evidenceField(source) };
}

function result(
  passName: StructuredPassName,
  category: VerificationCategory,
  verdict: Verdict,
  severity: Severity,
  message: string,
  foundEvidence: Evidence[] = [],
): VerificationResult {
  return {
    passName,
    verdict,
    severity,
    confidence: "high",
    evidence: foundEvidence,
    message: boundedMessage(message),
    category,
  };
}

function pass(
  name: StructuredPassName,
  category: VerificationCategory,
  run: (input: VerificationInput) => VerificationResult,
): VerificationPass {
  return {
    name,
    category,
    async run(input) {
      return run(input);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envFromContext(input: VerificationInput): NodeJS.ProcessEnv {
  const rawEnv = input.context?.env;
  if (!isRecord(rawEnv)) return {};
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function postureFlagFromContext(input: VerificationInput): unknown {
  if (input.context !== undefined && Object.hasOwn(input.context, "posture")) {
    return input.context.posture;
  }
  const options = input.context?.options;
  return isRecord(options) && Object.hasOwn(options, "posture") ? options.posture : undefined;
}

function contextDirFromContext(input: VerificationInput): string {
  const value = input.context?.contextDir;
  if (typeof value !== "string") return "ai-coding";
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return "ai-coding";
  }
  return normalized;
}

function contextDocPath(input: VerificationInput, file: string): string {
  return `${contextDirFromContext(input)}/${file}`;
}

function policyPlanContext(
  input: VerificationInput,
  env: NodeJS.ProcessEnv,
  posture: Posture,
): PlanContext {
  return {
    root: input.projectRoot,
    contextDir: contextDirFromContext(input),
    posture,
    apply: false,
    verify: true,
    json: false,
    run: STRUCTURED_VERIFICATION_RUNNER,
    host: makeHostAdapter({ run: STRUCTURED_VERIFICATION_RUNNER, env }),
    env,
    options: {},
  };
}

function policyCheckEvidence(check: Check): Evidence[] {
  return [
    evidence(
      check.fingerprint ?? `policy:${check.code ?? check.verdict}`,
      check.code ?? "policy-check",
      check.location?.uri ?? AIH_ORG_POLICY_FILE,
    ),
  ];
}

function fileExists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

function readJsonFile(
  root: string,
  rel: string,
):
  | { kind: "absent" }
  | { kind: "invalid" }
  | {
      kind: "present";
      value: unknown;
    } {
  const abs = join(root, rel);
  if (!existsSync(abs)) return { kind: "absent" };
  try {
    return { kind: "present", value: JSON.parse(readFileSync(abs, "utf8")) };
  } catch {
    return { kind: "invalid" };
  }
}

function invalidPackageResult(
  passName: StructuredPassName,
  category: VerificationCategory,
): VerificationResult {
  return result(passName, category, "fail", "high", "package.json is not valid JSON", [
    evidence(`${passName}:package-json-invalid`, "file", PACKAGE_JSON),
  ]);
}

function packageScripts(manifest: unknown): Record<string, string> {
  if (!isRecord(manifest) || !isRecord(manifest.scripts)) return {};
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(manifest.scripts)) {
    if (typeof value === "string") scripts[name] = value;
  }
  return scripts;
}

function dependencySections(
  manifest: unknown,
): Array<[section: string, entries: Record<string, string>]> {
  if (!isRecord(manifest)) return [];
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return sections.flatMap((section) => {
    const value = manifest[section];
    if (!isRecord(value)) return [];
    const entries: Record<string, string> = {};
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec === "string") entries[name] = spec;
    }
    return [[section, entries] as [string, Record<string, string>]];
  });
}

function dependencyEvidenceId(section: string, name: string): string {
  const label = section === "dependencies" ? "dependency" : section;
  return `dependency:${label}:${name}`;
}

function riskyDependencySpec(spec: string): boolean {
  return (
    spec === "*" ||
    spec === "latest" ||
    /^https?:\/\//i.test(spec) ||
    /^git(?:\+|:\/\/|@)/i.test(spec)
  );
}

function pipesRemoteContentToShell(script: string): boolean {
  return (
    REMOTE_PIPE_EXEC_RE.test(script) ||
    REMOTE_PROCESS_SUBSTITUTION_RE.test(script) ||
    POWERSHELL_REMOTE_INVOKE_RE.test(script)
  );
}

function execLocalityPass(): VerificationPass {
  return pass("exec-locality", "exec", (input) => {
    const pkg = readJsonFile(input.projectRoot, PACKAGE_JSON);
    if (pkg.kind === "absent") {
      return result(
        "exec-locality",
        "exec",
        "pass",
        "info",
        "skipped: no package.json surface to inspect",
      );
    }
    if (pkg.kind === "invalid") return invalidPackageResult("exec-locality", "exec");
    const hits = Object.entries(packageScripts(pkg.value))
      .filter(([, script]) => pipesRemoteContentToShell(script))
      .map(([name]) =>
        evidence(`exec-locality:script:${name}`, "package-script", `package.json#scripts.${name}`),
      );
    if (hits.length > 0) {
      return result(
        "exec-locality",
        "exec",
        "fail",
        "high",
        `${hits.length} package script(s) pipe remote content into a shell`,
        hits,
      );
    }
    return result("exec-locality", "exec", "pass", "info", "no remote shell-pipe scripts found");
  });
}

function policyPass(): VerificationPass {
  return pass("policy", "policy", (input) => {
    const env = envFromContext(input);
    const postureFlag = postureFlagFromContext(input);
    let resolved: ReturnType<typeof resolvePosture>;
    try {
      resolved = resolvePosture({
        root: input.projectRoot,
        env,
        flag: postureFlag,
        flagSource: postureFlag === undefined ? undefined : "cli",
      });
    } catch {
      try {
        readOrgPolicy(input.projectRoot, env);
      } catch {
        return result("policy", "policy", "fail", "high", `${AIH_ORG_POLICY_FILE} is invalid`, [
          evidence("policy:invalid", "file", AIH_ORG_POLICY_FILE),
        ]);
      }
      return result("policy", "policy", "fail", "high", "policy posture could not be resolved", [
        evidence("policy:posture-invalid", "policy", AIH_ORG_POLICY_FILE),
      ]);
    }

    let policy: ReturnType<typeof readOrgPolicy>;
    try {
      policy = readOrgPolicy(input.projectRoot, env);
    } catch {
      return result("policy", "policy", "fail", "high", `${AIH_ORG_POLICY_FILE} is invalid`, [
        evidence("policy:invalid", "file", AIH_ORG_POLICY_FILE),
      ]);
    }
    if (resolved.posture === "enterprise") {
      try {
        const check = enterpriseBaselineAttestationCheck(
          policyPlanContext(input, env, resolved.posture),
        );
        if (check.verdict === "fail") {
          return result(
            "policy",
            "policy",
            "fail",
            "high",
            check.detail ?? `${check.name} failed`,
            policyCheckEvidence(check),
          );
        }
        return result(
          "policy",
          "policy",
          "pass",
          "info",
          check.detail ??
            `${AIH_ORG_POLICY_FILE} parses and enterprise baseline attestation passed`,
          [evidence("policy:org-policy", "file", AIH_ORG_POLICY_FILE)],
        );
      } catch {
        return result(
          "policy",
          "policy",
          "fail",
          "high",
          "enterprise baseline attestation could not complete",
          [evidence("policy:baseline-attestation-error", "policy", AIH_ORG_POLICY_FILE)],
        );
      }
    }

    if (policy === undefined) {
      return result(
        "policy",
        "policy",
        "pass",
        "info",
        `skipped: no ${AIH_ORG_POLICY_FILE} in this repo`,
      );
    }
    return result(
      "policy",
      "policy",
      "pass",
      "info",
      `${AIH_ORG_POLICY_FILE} parses with minimumPosture ${policy.minimumPosture}; effective posture ${resolved.posture}`,
      [evidence("policy:org-policy", "file", AIH_ORG_POLICY_FILE)],
    );
  });
}

function securityPass(): VerificationPass {
  return pass("security", "security", (input) => {
    const plaintext = scanSecrets(input.projectRoot).matches.map((source) =>
      evidence(`security:plaintext:${source}`, "secret-surface", source),
    );
    const configHits = scanConfigSecrets(input.projectRoot).map((hit) =>
      evidence(`security:config:${hit.file}:${hit.key || hit.kind}`, "config-secret", hit.file),
    );
    const hits = [...plaintext, ...configHits];
    if (hits.length > 0) {
      return result(
        "security",
        "security",
        "fail",
        "critical",
        `${hits.length} plaintext secret surface(s) found`,
        hits,
      );
    }
    return result("security", "security", "pass", "info", "no plaintext secret surfaces found");
  });
}

function dependencyPass(): VerificationPass {
  return pass("dependency", "dependency", (input) => {
    const pkg = readJsonFile(input.projectRoot, PACKAGE_JSON);
    if (pkg.kind === "absent") {
      return result(
        "dependency",
        "dependency",
        "pass",
        "info",
        "skipped: no package.json dependency surface to inspect",
      );
    }
    if (pkg.kind === "invalid") return invalidPackageResult("dependency", "dependency");
    const hits = dependencySections(pkg.value).flatMap(([section, entries]) =>
      Object.entries(entries)
        .filter(([, spec]) => riskyDependencySpec(spec))
        .map(([name]) =>
          evidence(
            dependencyEvidenceId(section, name),
            "package-dependency",
            `package.json#${section}.${name}`,
          ),
        ),
    );
    if (hits.length > 0) {
      return result(
        "dependency",
        "dependency",
        "warn",
        "medium",
        `${hits.length} dependency spec(s) need pinned provenance`,
        hits,
      );
    }
    return result("dependency", "dependency", "pass", "info", "dependency specs look pinned");
  });
}

function docConsistencyPass(): VerificationPass {
  return pass("doc-consistency", "doc", (input) => {
    const routerPath = contextDocPath(input, RULE_ROUTER_FILE);
    const projectPath = contextDocPath(input, PROJECT_FILE);
    const hasRouter = fileExists(input.projectRoot, routerPath);
    const hasProject = fileExists(input.projectRoot, projectPath);
    if (!hasRouter && !hasProject) {
      return result(
        "doc-consistency",
        "doc",
        "pass",
        "info",
        `skipped: no ${contextDirFromContext(input)} documentation surface to inspect`,
      );
    }
    const missing: Evidence[] = [];
    if (!hasRouter) {
      missing.push(evidence("doc-consistency:missing:router", "file", routerPath));
    }
    if (!hasProject) {
      missing.push(evidence("doc-consistency:missing:project", "file", projectPath));
    }
    if (missing.length > 0) {
      return result(
        "doc-consistency",
        "doc",
        "warn",
        "low",
        `${missing.length} ai-coding documentation artifact(s) are missing`,
        missing,
      );
    }
    return result(
      "doc-consistency",
      "doc",
      "pass",
      "info",
      `${contextDirFromContext(input)} documentation artifacts are present`,
      [
        evidence("doc-consistency:router", "file", routerPath),
        evidence("doc-consistency:project", "file", projectPath),
      ],
    );
  });
}

export function createStructuredVerificationPasses(): VerificationPass[] {
  return [execLocalityPass(), policyPass(), securityPass(), dependencyPass(), docConsistencyPass()];
}

export function createStructuredVerificationRegistry(): VerificationRegistry {
  const registry = new VerificationRegistry();
  for (const verificationPass of createStructuredVerificationPasses()) {
    registry.register(verificationPass);
  }
  return registry;
}
