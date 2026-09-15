import { createHash } from "node:crypto";
import { z } from "zod";
import { ContextDir } from "../config/settings.js";
import { AihError } from "../errors.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { type Action, remove, writeJson, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";

export const POLICY_REQUIRED_GUIDANCE_FILE = "policy-required-guidance.md";
export const POLICY_REQUIRED_GUIDANCE_RECEIPT_FILE = "policy-required-guidance.receipt.json";
const MAX_BYTES = 256 * 1024;
const ReceiptSchema = z
  .object({
    format: z.literal("aih-policy-required-guidance-receipt"),
    schemaVersion: z.literal(1),
    path: z.string().min(1).max(1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: z.string().min(1).max(200),
    source: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict(),
    targets: z.array(z.enum(SUPPORTED_CLIS)).min(1).max(SUPPORTED_CLIS.length),
    components: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/),
            paths: z.array(z.string().min(1).max(1024)).min(1),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
type Receipt = z.infer<typeof ReceiptSchema>;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contextPath(contextDir: string, file: string): string {
  const parsed = ContextDir.safeParse(contextDir);
  if (!parsed.success) throw new Error("invalid context directory for required policy guidance");
  return `${parsed.data.replace(/\\/g, "/")}/${file}`;
}

export function policyRequiredGuidancePath(contextDir: string): string {
  return contextPath(contextDir, POLICY_REQUIRED_GUIDANCE_FILE);
}

export interface RequiredGuidanceComponent {
  id: string;
  files: readonly { path: string }[];
}

export interface PolicyRequiredGuidanceIdentity {
  policyVersion: string;
  source: { repository: string; commit: string };
  targets: readonly (typeof SUPPORTED_CLIS)[number][];
}

export interface ExpectedPolicyRequiredGuidance {
  path: string;
  contents: string;
  sha256: string;
  policyVersion: string;
  source: { repository: string; commit: string };
  targets: (typeof SUPPORTED_CLIS)[number][];
  components: Array<{ id: string; paths: string[] }>;
}

function requiredSelections(
  components: readonly RequiredGuidanceComponent[],
): Array<{ id: string; paths: string[] }> {
  const byId = new Map<string, Set<string>>();
  for (const component of components) {
    for (const file of component.files) {
      const selectedGuidance =
        file.path.endsWith("/SKILL.md") ||
        /(^|\/)(?:agents|commands|rules|steering)\/.*\.md$/.test(file.path);
      if (!selectedGuidance) continue;
      const paths = byId.get(component.id) ?? new Set<string>();
      paths.add(file.path);
      byId.set(component.id, paths);
    }
  }
  return [...byId]
    .map(([id, paths]) => ({ id, paths: [...paths].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Shared predicate for writers and read-only delivery reports. */
export function hasRequiredGuidanceComponents(
  components: readonly RequiredGuidanceComponent[],
): boolean {
  return requiredSelections(components).length > 0;
}

/** Pure expected bytes and identity for reporters as well as the writer. */
export function expectedPolicyRequiredGuidance(
  contextDir: string,
  components: readonly RequiredGuidanceComponent[],
  identity: PolicyRequiredGuidanceIdentity,
): ExpectedPolicyRequiredGuidance | undefined {
  const selected = requiredSelections(components);
  if (selected.length === 0) return undefined;
  const parsedIdentity = z
    .object({
      policyVersion: z.string().min(1).max(200),
      source: ReceiptSchema.shape.source,
      targets: ReceiptSchema.shape.targets,
    })
    .strict()
    .parse({
      ...identity,
      targets: [...new Set(identity.targets)].sort(),
    });
  const path = policyRequiredGuidancePath(contextDir);
  const contents = lines(
    "# Required organization guidance",
    "",
    "This file is generated from the evidence-passed organization policy selection.",
    `Policy version: ${parsedIdentity.policyVersion}`,
    `Verified ECC source: ${parsedIdentity.source.repository}@${parsedIdentity.source.commit}`,
    `Governed targets: ${parsedIdentity.targets.join(", ")}`,
    "",
    "At the start of every task, read every selected guidance file listed below in full before acting:",
    "",
    ...selected.flatMap((component) =>
      component.paths.map((componentPath) => `- \`${componentPath}\` (${component.id})`),
    ),
  );
  return {
    path,
    contents,
    sha256: sha256(contents),
    ...parsedIdentity,
    components: selected,
  };
}

type ReadState = Buffer | "absent" | "unsafe";
function readOwnedFile(root: string, path: string): ReadState {
  const inspected = inspectContainedRelativePath(root, path);
  if (inspected.state === "absent") return "absent";
  if (inspected.state === "unsafe" || inspected.kind !== "file") return "unsafe";
  const opened = readRegularFileWithStats(inspected.realPath, { maxBytes: MAX_BYTES });
  return opened === undefined || opened.identity.nlink !== 1n ? "unsafe" : opened.contents;
}

type ReceiptState =
  | { state: "absent" }
  | { state: "malformed"; detail: string }
  | { state: "valid"; receipt: Receipt; rawSha256: string };

function readReceipt(root: string, contextDir: string): ReceiptState {
  const raw = readOwnedFile(root, contextPath(contextDir, POLICY_REQUIRED_GUIDANCE_RECEIPT_FILE));
  if (raw === "absent") return { state: "absent" };
  if (raw === "unsafe")
    return {
      state: "malformed",
      detail: "required-guidance receipt is not a safe bounded regular file",
    };
  try {
    const receipt = ReceiptSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    );
    if (receipt.path !== policyRequiredGuidancePath(contextDir)) {
      return {
        state: "malformed",
        detail: "required-guidance receipt path does not match the context directory",
      };
    }
    return { state: "valid", receipt, rawSha256: sha256(raw) };
  } catch (error) {
    return {
      state: "malformed",
      detail: `invalid required-guidance receipt: ${(error as Error).message}`,
    };
  }
}

export interface PolicyRequiredGuidanceInspection {
  state: "absent" | "current" | "stale" | "missing" | "drifted" | "malformed";
  path: string;
  receiptPath: string;
  receipt?: Receipt;
  detail?: string;
}

export function inspectPolicyRequiredGuidance(
  root: string,
  contextDir: string,
  expected?: ExpectedPolicyRequiredGuidance,
): PolicyRequiredGuidanceInspection {
  const path = policyRequiredGuidancePath(contextDir);
  const receiptPath = contextPath(contextDir, POLICY_REQUIRED_GUIDANCE_RECEIPT_FILE);
  const receipt = readReceipt(root, contextDir);
  if (receipt.state === "absent") return { state: "absent", path, receiptPath };
  if (receipt.state === "malformed")
    return { state: "malformed", path, receiptPath, detail: receipt.detail };
  const live = readOwnedFile(root, path);
  if (live === "absent") return { state: "missing", path, receiptPath, receipt: receipt.receipt };
  if (live === "unsafe") {
    return {
      state: "drifted",
      path,
      receiptPath,
      receipt: receipt.receipt,
      detail: "guidance is not a safe bounded regular file",
    };
  }
  if (sha256(live) !== receipt.receipt.sha256) {
    return {
      state: "drifted",
      path,
      receiptPath,
      receipt: receipt.receipt,
      detail: "guidance bytes do not match their ownership receipt",
    };
  }
  if (
    expected !== undefined &&
    (receipt.receipt.sha256 !== expected.sha256 ||
      receipt.receipt.policyVersion !== expected.policyVersion ||
      receipt.receipt.source.repository !== expected.source.repository ||
      receipt.receipt.source.commit !== expected.source.commit ||
      JSON.stringify(receipt.receipt.targets) !== JSON.stringify(expected.targets) ||
      JSON.stringify(receipt.receipt.components) !== JSON.stringify(expected.components))
  ) {
    return {
      state: "stale",
      path,
      receiptPath,
      receipt: receipt.receipt,
      detail: "guidance receipt does not match the effective policy selection and target identity",
    };
  }
  return { state: "current", path, receiptPath, receipt: receipt.receipt };
}

export interface PolicyRequiredGuidancePlan {
  actions: Action[];
  inspection: PolicyRequiredGuidanceInspection;
  advisories: string[];
}

export function planPolicyRequiredGuidance(
  root: string,
  contextDir: string,
  components: readonly RequiredGuidanceComponent[],
  identity?: PolicyRequiredGuidanceIdentity,
): PolicyRequiredGuidancePlan {
  const path = policyRequiredGuidancePath(contextDir);
  const receiptPath = contextPath(contextDir, POLICY_REQUIRED_GUIDANCE_RECEIPT_FILE);
  const expected =
    identity === undefined
      ? undefined
      : expectedPolicyRequiredGuidance(contextDir, components, identity);
  const required = requiredSelections(components);
  if (required.length > 0 && expected === undefined) {
    throw new AihError("required guidance identity is missing", "AIH_TRUST");
  }
  const inspection = inspectPolicyRequiredGuidance(root, contextDir, expected);
  const receipt = readReceipt(root, contextDir);
  if (receipt.state === "malformed") throw new AihError(receipt.detail, "AIH_TRUST");
  if (required.length === 0) {
    if (receipt.state === "absent") return { actions: [], inspection, advisories: [] };
    if (inspection.state === "drifted")
      return {
        actions: [],
        inspection,
        advisories: [inspection.detail ?? "required guidance drifted; preserved"],
      };
    const actions: Action[] = [];
    if (inspection.state === "current")
      actions.push(
        remove(path, "subtract required organization guidance bridge", {
          hardDelete: true,
          expect: { sha256: receipt.receipt.sha256 },
        }),
      );
    actions.push(
      remove(receiptPath, "subtract required organization guidance ownership receipt", {
        hardDelete: true,
        expect: { sha256: receipt.rawSha256 },
      }),
    );
    return { actions, inspection, advisories: [] };
  }
  const live = readOwnedFile(root, path);
  if (receipt.state === "absent" && live !== "absent")
    throw new AihError(`refusing to overwrite unowned required guidance at ${path}`, "AIH_TRUST");
  if (inspection.state === "drifted") {
    throw new AihError(inspection.detail ?? `required guidance drifted at ${path}`, "AIH_TRUST");
  }
  if (expected === undefined)
    throw new AihError("required guidance identity is missing", "AIH_TRUST");
  const nextReceipt: Receipt = {
    format: "aih-policy-required-guidance-receipt",
    schemaVersion: 1,
    path,
    sha256: expected.sha256,
    policyVersion: expected.policyVersion,
    source: expected.source,
    targets: expected.targets,
    components: expected.components,
  };
  return {
    actions: [
      writeText(path, expected.contents, "project required organization guidance bridge", {
        expect:
          live === "absent"
            ? { absent: true }
            : { sha256: receipt.state === "valid" ? receipt.receipt.sha256 : expected.sha256 },
      }),
      writeJson(receiptPath, nextReceipt, "required organization guidance ownership receipt", {
        expect: receipt.state === "absent" ? { absent: true } : { sha256: receipt.rawSha256 },
      }),
    ],
    inspection,
    advisories: [],
  };
}
