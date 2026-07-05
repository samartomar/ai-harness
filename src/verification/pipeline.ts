import {
  DEFAULT_MAX_EVIDENCE_PER_PASS,
  DEFAULT_VERIFICATION_PASS_TIMEOUT_MS,
  MAX_VERIFICATION_PASSES,
  MAX_VERIFICATION_STRING_FIELD_LENGTH,
  VERIFICATION_CATEGORIES,
  VERIFICATION_CONFIDENCES,
  VERIFICATION_SEVERITIES,
  VERIFICATION_VERDICTS,
} from "./constants.js";
import { buildEvidenceGraph } from "./graph.js";
import { mergeVerificationResults } from "./merge.js";
import type {
  Evidence,
  VerificationCategory,
  VerificationInput,
  VerificationPass,
  VerificationPipelineOptions,
  VerificationPipelineRun,
  VerificationResult,
} from "./types.js";
import { isWellFormedUtf16 } from "./validation.js";

function assertPassName(name: string): void {
  if (name.trim() === "") throw new Error("verification pass name is required");
  if (name.length > MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    throw new Error(
      `verification pass name is too long: ${name.length}/${MAX_VERIFICATION_STRING_FIELD_LENGTH}`,
    );
  }
  if (!isWellFormedUtf16(name)) throw new Error("verification pass name is malformed UTF-16");
}

function assertUniquePasses(passes: readonly VerificationPass[]): void {
  if (passes.length === 0) throw new Error("runVerificationPipeline requires at least one pass");
  if (passes.length > MAX_VERIFICATION_PASSES) {
    throw new Error(
      `runVerificationPipeline received too many passes: ${passes.length}/${MAX_VERIFICATION_PASSES}`,
    );
  }
  const seen = new Set<string>();
  for (const pass of passes) {
    assertPassName(pass.name);
    if (seen.has(pass.name))
      throw new Error(`verification pass listed more than once: ${pass.name}`);
    seen.add(pass.name);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(passName: string, record: Record<string, unknown>, field: string): string {
  return readStringValue(passName, field, record[field]);
}

function readStringValue(passName: string, field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`verification pass returned invalid ${field}: ${passName} -> ${String(value)}`);
  }
  if (value.length > MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    throw new Error(
      `verification pass returned ${field} that is too long: ${passName} -> ${value.length}/${MAX_VERIFICATION_STRING_FIELD_LENGTH}`,
    );
  }
  if (!isWellFormedUtf16(value)) {
    throw new Error(`verification pass returned malformed ${field}: ${passName}`);
  }
  return value;
}

function readMember<T extends string>(
  passName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`verification pass returned invalid ${field}: ${passName} -> ${String(value)}`);
  }
  return value as T;
}

function isVerificationCategory(value: unknown): value is VerificationCategory {
  return (
    typeof value === "string" && VERIFICATION_CATEGORIES.includes(value as VerificationCategory)
  );
}

function categoryFor(pass: VerificationPass): VerificationCategory {
  return isVerificationCategory(pass.category) ? pass.category : "other";
}

function validateEvidence(passName: string, index: number, value: unknown): Evidence {
  if (!isRecord(value)) {
    throw new Error(`verification pass returned invalid evidence: ${passName}[${index}]`);
  }
  const id = readStringValue(passName, "evidence.id", value.id);
  const type = readStringValue(passName, "evidence.type", value.type);
  const source = readStringValue(passName, "evidence.source", value.source);
  const snippet = value.snippet;
  if (snippet !== undefined && typeof snippet !== "string") {
    throw new Error(`verification pass returned invalid evidence.snippet: ${passName}[${index}]`);
  }
  if (snippet !== undefined && snippet.length > MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    throw new Error(
      `verification pass returned evidence.snippet that is too long: ${passName}[${index}] -> ${snippet.length}/${MAX_VERIFICATION_STRING_FIELD_LENGTH}`,
    );
  }
  if (snippet !== undefined && !isWellFormedUtf16(snippet)) {
    throw new Error(`verification pass returned malformed evidence.snippet: ${passName}[${index}]`);
  }
  return snippet === undefined ? { id, type, source } : { id, type, source, snippet };
}

function timeoutResult(pass: VerificationPass, timeoutMs: number): VerificationResult {
  return {
    passName: pass.name,
    verdict: "fail",
    severity: "high",
    confidence: "high",
    evidence: [],
    message: `verification pass timed out after ${timeoutMs}ms`,
    category: categoryFor(pass),
  };
}

function thrownResult(pass: VerificationPass): VerificationResult {
  return {
    passName: pass.name,
    verdict: "fail",
    severity: "high",
    confidence: "high",
    evidence: [],
    message: "verification pass threw before returning a result",
    category: categoryFor(pass),
  };
}

function abortedResult(pass: VerificationPass): VerificationResult {
  return {
    passName: pass.name,
    verdict: "fail",
    severity: "high",
    confidence: "high",
    evidence: [],
    message: "verification pipeline aborted before pass completed",
    category: categoryFor(pass),
  };
}

function timeoutFor(options: VerificationPipelineOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_PASS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`verification pass timeout must be a positive number: ${String(timeoutMs)}`);
  }
  return timeoutMs;
}

function maxEvidenceFor(options: VerificationPipelineOptions): number {
  const maxEvidencePerPass = options.maxEvidencePerPass ?? DEFAULT_MAX_EVIDENCE_PER_PASS;
  if (!Number.isSafeInteger(maxEvidencePerPass) || maxEvidencePerPass < 1) {
    throw new Error(
      `verification max evidence per pass must be a positive integer: ${String(maxEvidencePerPass)}`,
    );
  }
  return maxEvidencePerPass;
}

function validateVerificationResult(
  pass: VerificationPass,
  value: unknown,
  maxEvidencePerPass: number,
): VerificationResult {
  if (!isRecord(value)) {
    throw new Error(`verification pass returned non-object result: ${pass.name}`);
  }
  const passName = readStringField(pass.name, value, "passName");
  if (passName !== pass.name) {
    throw new Error(`verification pass returned mismatched passName: ${pass.name} -> ${passName}`);
  }
  const evidenceValue = value.evidence;
  if (!Array.isArray(evidenceValue)) {
    throw new Error(`verification pass returned invalid evidence: ${pass.name}`);
  }
  if (evidenceValue.length > maxEvidencePerPass) {
    throw new Error(
      `verification pass returned too much evidence: ${pass.name} -> ${evidenceValue.length}/${maxEvidencePerPass}`,
    );
  }
  return {
    passName,
    verdict: readMember(pass.name, "verdict", value.verdict, VERIFICATION_VERDICTS),
    severity: readMember(pass.name, "severity", value.severity, VERIFICATION_SEVERITIES),
    confidence: readMember(pass.name, "confidence", value.confidence, VERIFICATION_CONFIDENCES),
    evidence: evidenceValue.map((entry, index) => validateEvidence(pass.name, index, entry)),
    message: readStringField(pass.name, value, "message"),
    category: readMember(
      pass.name,
      "category",
      value.category === undefined ? categoryFor(pass) : value.category,
      VERIFICATION_CATEGORIES,
    ),
  };
}

type PassOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "timeout"; result: VerificationResult }
  | { kind: "thrown"; result: VerificationResult }
  | { kind: "aborted"; result: VerificationResult };

async function runPassWithTimeout(
  pass: VerificationPass,
  input: VerificationInput,
  timeoutMs: number,
  maxEvidencePerPass: number,
): Promise<VerificationResult> {
  const controller = new AbortController();
  let resolveAbort: ((outcome: PassOutcome) => void) | undefined;
  const abort = new Promise<PassOutcome>((resolve) => {
    resolveAbort = resolve;
  });
  const abortFromCaller = () => {
    controller.abort();
    resolveAbort?.({ kind: "aborted", result: abortedResult(pass) });
  };
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (input.signal?.aborted) {
    abortFromCaller();
    input.signal?.removeEventListener("abort", abortFromCaller);
    return abortedResult(pass);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PassOutcome>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout", result: timeoutResult(pass, timeoutMs) });
    }, timeoutMs);
  });
  const passInput: VerificationInput = { ...input, signal: controller.signal };
  const run = pass
    .run(passInput)
    .then((value) => ({ kind: "result", value }) as const)
    .catch(() => ({ kind: "thrown", result: thrownResult(pass) }) as const);

  try {
    const outcome = await Promise.race(
      input.signal === undefined ? [run, timeout] : [run, timeout, abort],
    );
    if (outcome.kind !== "result") return outcome.result;
    return validateVerificationResult(pass, outcome.value, maxEvidencePerPass);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function runVerificationPipeline(
  input: VerificationInput,
  options: VerificationPipelineOptions,
): Promise<VerificationPipelineRun> {
  assertUniquePasses(options.passes);
  const timeoutMs = timeoutFor(options);
  const maxEvidencePerPass = maxEvidenceFor(options);
  const results = await Promise.all(
    options.passes.map(async (pass) =>
      runPassWithTimeout(pass, input, timeoutMs, maxEvidencePerPass),
    ),
  );
  return {
    results,
    summary: mergeVerificationResults(results),
    evidenceGraph: buildEvidenceGraph(results, { maxEvidencePerResult: maxEvidencePerPass }),
  };
}
