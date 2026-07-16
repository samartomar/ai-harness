import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { AihError } from "../errors.js";
import type { CommandSpec } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { qualifyEccInert } from "./adapters/ecc-qualification.js";
import { qualifyGstackInert } from "./adapters/gstack-qualification.js";
import { serializeCompatibilityKey } from "./contracts/compatibility.js";
import { createHostLoadSurfaceContract, hostLoadSurfaces } from "./contracts/host.js";
import { createQualificationReport } from "./report.js";
import { parseMethodologyProposal } from "./schema.js";
import { classifyEnrollment } from "./state.js";

const CODEx_HOST_CONTRACT = "codex-0.144.1-windows-x64-v1";
const METHODOLOGY_PROPOSAL_FILE = "aih-methodology.json";
const GIT_COMMIT = /^[0-9a-f]{40}$/;

type MethodologyAction = "inspect" | "plan" | "qualify" | "status";
type MethodologyProvider = "ecc" | "gstack";

interface MethodologyFinding {
  code: string;
  summary: string;
  safeRetry?: string;
  stopCondition?: string;
}

export interface MethodologyCommandResult {
  status: "success" | "warning" | "error";
  summary: string;
  nextActions: readonly string[];
  artifacts: readonly string[];
  findings: readonly MethodologyFinding[];
  value: Record<string, unknown>;
}

const methodologyExitCodes = {
  inspectionOrPass: 0,
  invalidInputOrCommandFailure: 1,
  qualificationBlocked: 2,
  qualificationFailedClosed: 3,
} as const;

export interface RunMethodologyCommandInput {
  action: MethodologyAction;
  provider?: string;
  sourceRoot?: string;
  host?: string;
  root?: string;
  runner?: Runner;
  now?: () => string;
}

interface QualifiedProvider {
  source: { repository: string; resolvedCommit: string; treeSha256: string };
  discovery: {
    installerEntries: readonly string[];
    installerContractFingerprint: string;
  };
  topology: object;
  plan: {
    digest: string;
    impacts: Record<string, string>;
    providerCodeExecuted: false;
  };
  compatibilityKey: Parameters<typeof serializeCompatibilityKey>[0];
  compatibility: {
    status: "supported" | "unknown";
    finding?: string;
    safeRetry?: string;
    stopCondition?: string;
  };
  qualification: {
    classification: "QUALIFICATION_PASS" | "QUALIFICATION_FAIL_CLOSED" | "QUALIFICATION_BLOCKED";
    supportLevel: "discoverable" | "evaluable" | "plannable" | "mutation-research-eligible";
    findings: readonly string[];
    providerCodeExecuted: false;
  };
  providerCodeExecuted: false;
}

function commandSpec(name: MethodologyAction, options: CommandSpec["options"] = []): CommandSpec {
  return {
    name,
    summary: `Read-only methodology ${name}`,
    readOnly: true,
    options,
    plan: () => ({ capability: `methodology:${name}`, actions: [] }),
  };
}

export const methodologyCommandSpecs: readonly CommandSpec[] = [
  commandSpec("inspect", [
    {
      flags: "--source-root <path>",
      description: "operator-supplied exact local provider checkout",
    },
  ]),
  commandSpec("plan", [
    {
      flags: "--source-root <path>",
      description: "operator-supplied exact local provider checkout",
    },
    { flags: "--host <host>", description: "known host load-surface contract ID" },
  ]),
  commandSpec("qualify", [
    {
      flags: "--source-root <path>",
      description: "operator-supplied exact local provider checkout",
    },
    { flags: "--host <host>", description: "known host load-surface contract ID" },
  ]),
  commandSpec("status", [{ flags: "--root <path>", description: "project root to inspect" }]),
];

function commandFailure(message: string, code: string): never {
  throw new AihError(message, code);
}

function knownProvider(provider: string | undefined): MethodologyProvider {
  if (provider === "ecc" || provider === "gstack") return provider;
  return commandFailure(
    "provider is not supported by the Phase A qualification surface",
    "PROVIDER_UNKNOWN",
  );
}

function sourceRoot(sourceRoot: string | undefined): string {
  if (sourceRoot === undefined || !isAbsolute(sourceRoot)) {
    return commandFailure(
      "source root must be an absolute operator-supplied path",
      "PROVIDER_SOURCE_UNRESOLVED",
    );
  }
  try {
    const stat = lstatSync(sourceRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return commandFailure("source root must be a real directory", "PROVIDER_SOURCE_UNRESOLVED");
    }
    return realpathSync(sourceRoot);
  } catch (error) {
    if (error instanceof AihError) throw error;
    return commandFailure("source root is unavailable", "PROVIDER_SOURCE_UNRESOLVED");
  }
}

function hostContract(host: string | undefined) {
  if (host !== CODEx_HOST_CONTRACT) {
    return commandFailure(
      "host contract is not supported by the Phase A qualification surface",
      "HOST_UNSUPPORTED",
    );
  }
  return createHostLoadSurfaceContract({
    id: CODEx_HOST_CONTRACT,
    host: { id: "codex", version: "0.144.1", build: "cbacbb97" },
    surfaces: hostLoadSurfaces.map((surface) => ({
      surface,
      coverage:
        surface === "cache-and-session-persistence" ? ("partial" as const) : ("complete" as const),
      evidence: ["codex-0.144.1-windows-x64.md"],
      positiveProbe: "designed",
      negativeProbe: "designed",
    })),
  });
}

function inspectionHostContract() {
  return createHostLoadSurfaceContract({
    id: "host-not-supplied-v1",
    host: { id: "unknown", version: "unknown", build: "unknown" },
    surfaces: hostLoadSurfaces.map((surface) => ({
      surface,
      coverage: "unknown" as const,
      evidence: [],
      positiveProbe: "not supplied",
      negativeProbe: "not supplied",
    })),
  });
}

function currentEnvironment() {
  const family =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : commandFailure(
              "operating system is not supported by the qualification surface",
              "HOST_UNSUPPORTED",
            );
  return {
    operatingSystem: { family, version: release(), architecture: process.arch },
    isolationMode: "unknown",
    runtimes: { node: process.versions.node },
    policyVersion: "enterprise-core-v1",
  } as const;
}

async function sourceRequest(
  provider: MethodologyProvider,
  root: string,
  runner: Runner,
): Promise<{ repository: string; root: string; resolvedCommit: string }> {
  const result = await runner(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
  const resolvedCommit = result.stdout.trim();
  if (result.spawnError || result.code !== 0 || !GIT_COMMIT.test(resolvedCommit)) {
    return commandFailure(
      "source root does not expose an exact local Git HEAD",
      "PROVIDER_SOURCE_UNRESOLVED",
    );
  }
  return {
    repository: provider === "ecc" ? "affaan-m/ECC" : "garrytan/gstack",
    root,
    resolvedCommit,
  };
}

async function qualifyProvider(
  provider: MethodologyProvider,
  root: string,
  host: ReturnType<typeof hostContract> | ReturnType<typeof inspectionHostContract>,
  runner: Runner,
): Promise<QualifiedProvider> {
  const source = await sourceRequest(provider, root, runner);
  const input = { source, runner, host, environment: currentEnvironment() };
  return provider === "ecc" ? await qualifyEccInert(input) : await qualifyGstackInert(input);
}

function inspectionValue(result: QualifiedProvider): Record<string, unknown> {
  return {
    source: result.source,
    installerEntries: result.discovery.installerEntries,
    installerContractFingerprint: result.discovery.installerContractFingerprint,
    topology: result.topology,
    plan: result.plan,
    providerCodeExecuted: false,
  };
}

function qualificationFinding(result: QualifiedProvider): MethodologyFinding[] {
  return result.qualification.findings.map((code) => ({
    code,
    summary: "The exact tuple is not eligible for a higher Phase A support level.",
    safeRetry: result.compatibility.safeRetry,
    stopCondition: result.compatibility.stopCondition,
  }));
}

function readMethodologyStatus(rootText: string | undefined): MethodologyCommandResult {
  const root = resolve(rootText ?? process.cwd());
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch {
    return commandFailure("methodology status root is unavailable", "METHODOLOGY_INTENT_INVALID");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return commandFailure(
      "methodology status root must be a real directory",
      "METHODOLOGY_INTENT_INVALID",
    );
  }
  const intentPath = join(root, METHODOLOGY_PROPOSAL_FILE);
  if (!existsSync(intentPath)) {
    return {
      status: "success",
      summary: "No methodology proposal is present; no provider is selected.",
      nextActions: ["Supply an exact local source only when beginning a read-only qualification."],
      artifacts: [],
      findings: [],
      value: {
        ...classifyEnrollment(undefined),
        latestQualification: "unknown",
        providerCodeExecuted: false,
      },
    };
  }
  if (lstatSync(intentPath).isSymbolicLink()) {
    return commandFailure(
      "methodology proposal must not be a symbolic link",
      "METHODOLOGY_INTENT_INVALID",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(intentPath, "utf8"));
  } catch {
    return commandFailure("methodology proposal is not valid JSON", "METHODOLOGY_INTENT_INVALID");
  }
  let proposal: ReturnType<typeof parseMethodologyProposal>;
  try {
    proposal = parseMethodologyProposal(parsed);
  } catch {
    return commandFailure("methodology proposal is invalid", "METHODOLOGY_INTENT_INVALID");
  }
  return {
    status: "warning",
    summary: "A methodology proposal is selected but no qualification result is stored.",
    nextActions: [
      "Run a read-only exact-source qualification before any future research decision.",
    ],
    artifacts: [METHODOLOGY_PROPOSAL_FILE],
    findings: [
      { code: "QUALIFICATION_INCOMPLETE", summary: "No stored exact qualification result exists." },
    ],
    value: {
      ...classifyEnrollment(proposal.provider.id),
      latestQualification: "unknown",
      providerCodeExecuted: false,
    },
  };
}

function errorResult(error: unknown): MethodologyCommandResult {
  const code = error instanceof AihError ? error.code : "QUALIFICATION_INCOMPLETE";
  return {
    status: "error",
    summary: "Methodology qualification stopped before producing a result.",
    nextActions: ["Correct the exact local input and retry the read-only command."],
    artifacts: [],
    findings: [{ code, summary: "A required qualification input could not be verified." }],
    value: { providerCodeExecuted: false },
  };
}

function qualificationClassification(
  result: MethodologyCommandResult,
): QualifiedProvider["qualification"]["classification"] | undefined {
  const qualification = result.value.qualification;
  if (qualification === null || typeof qualification !== "object") return undefined;
  const classification = (qualification as { classification?: unknown }).classification;
  if (
    classification === "QUALIFICATION_PASS" ||
    classification === "QUALIFICATION_BLOCKED" ||
    classification === "QUALIFICATION_FAIL_CLOSED"
  ) {
    return classification;
  }
  return undefined;
}

/** Maps the read-only methodology result to its stable process exit contract. */
export function methodologyExitCode(result: MethodologyCommandResult): number {
  if (result.status === "error") return methodologyExitCodes.invalidInputOrCommandFailure;
  switch (qualificationClassification(result)) {
    case "QUALIFICATION_BLOCKED":
      return methodologyExitCodes.qualificationBlocked;
    case "QUALIFICATION_FAIL_CLOSED":
      return methodologyExitCodes.qualificationFailedClosed;
    case "QUALIFICATION_PASS":
    case undefined:
      return methodologyExitCodes.inspectionOrPass;
  }
}

export async function runMethodologyCommand(
  input: RunMethodologyCommandInput,
): Promise<MethodologyCommandResult> {
  try {
    if (input.action === "status") return readMethodologyStatus(input.root);
    const provider = knownProvider(input.provider);
    const runner = input.runner ?? defaultRunner;
    const result = await qualifyProvider(
      provider,
      sourceRoot(input.sourceRoot),
      input.action === "inspect" ? inspectionHostContract() : hostContract(input.host),
      runner,
    );
    if (input.action === "inspect") {
      return {
        status: "success",
        summary: "Exact local provider source was inspected as inert data.",
        nextActions: ["Use plan or qualify with a known host contract for an exact tuple result."],
        artifacts: [],
        findings: [],
        value: inspectionValue(result),
      };
    }
    if (input.action === "plan") {
      return {
        status: "success",
        summary: "A deterministic proposed plan was derived from exact inert source data.",
        nextActions: ["Use qualify to evaluate the exact provider and host tuple."],
        artifacts: [],
        findings: [],
        value: {
          source: result.source,
          plan: result.plan,
          providerCodeExecuted: false,
        },
      };
    }
    const report = createQualificationReport({
      createdAt: input.now?.() ?? new Date().toISOString(),
      source: result.source,
      compatibilityKey: serializeCompatibilityKey(result.compatibilityKey),
      hostContract: result.compatibilityKey.host.loadSurfaceContractVersion,
      qualification: result.qualification,
    });
    return {
      status: result.qualification.classification === "QUALIFICATION_PASS" ? "success" : "warning",
      summary:
        result.qualification.classification === "QUALIFICATION_PASS"
          ? "Exact qualification completed at the Phase A support boundary."
          : result.qualification.classification === "QUALIFICATION_BLOCKED"
            ? "Exact qualification is blocked at the plannable support level."
            : "Exact qualification failed closed at the plannable support level.",
      nextActions: [
        "Review the reported exact tuple before considering any separate research authorization.",
      ],
      artifacts: [],
      findings: qualificationFinding(result),
      value: { ...report, plan: result.plan, providerCodeExecuted: false },
    };
  } catch (error) {
    return errorResult(error);
  }
}

function writeResult(result: MethodologyCommandResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.summary}\n`);
  for (const finding of result.findings)
    process.stdout.write(`${finding.code}: ${finding.summary}\n`);
}

function registerSourceCommand(methodology: Command, action: "inspect" | "plan" | "qualify"): void {
  const command = methodology
    .command(action)
    .description(`Read exact local provider source for methodology ${action}`)
    .argument("<provider>", "supported provider: ecc or gstack")
    .requiredOption("--source-root <path>", "operator-supplied exact local provider checkout")
    .option("--json", "emit machine-readable JSON");
  if (action !== "inspect")
    command.requiredOption("--host <host>", "known host load-surface contract ID");
  command.action(
    async (provider: string, options: { sourceRoot: string; host?: string; json?: boolean }) => {
      const result = await runMethodologyCommand({
        action,
        provider,
        sourceRoot: options.sourceRoot,
        host: options.host,
      });
      writeResult(result, options.json === true);
      process.exitCode = methodologyExitCode(result);
    },
  );
}

export function registerMethodologyCommands(program: Command): void {
  const methodology = program
    .command("methodology")
    .description("Read-only exact-source methodology qualification");
  registerSourceCommand(methodology, "inspect");
  registerSourceCommand(methodology, "plan");
  registerSourceCommand(methodology, "qualify");
  methodology
    .command("status")
    .description("Report proposal and qualification status without changing authority")
    .option("--root <path>", "project root to inspect")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { root?: string; json?: boolean }) => {
      const result = await runMethodologyCommand({ action: "status", root: options.root });
      writeResult(result, options.json === true);
      process.exitCode = methodologyExitCode(result);
    });
}
