import { createHash } from "node:crypto";
import { z } from "zod";
import { AihError } from "../errors.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { isPlainObject } from "../internals/merge.js";
import { type Action, doc, type PlanContext, remove, writeJson } from "../internals/plan.js";
import { composeOrgPolicy } from "./compose.js";
import type { OrgPolicy } from "./schema.js";

export const COMMAND_PERMISSION_PATH = ".claude/settings.json";
export const COMMAND_PERMISSION_RECEIPT = ".aih/org-policy/command-permissions-v1.json";
const MAX_BYTES = 1024 * 1024;
const TIERS = ["deny", "ask", "allow"] as const;
type Permissions = Record<(typeof TIERS)[number], string[]>;
const Strings = z.array(z.string().min(1).max(4096)).max(4096);
const PermissionSchema = z.object({ deny: Strings, ask: Strings, allow: Strings }).strict();
const ReceiptSchema = z
  .object({
    format: z.literal("aih-command-permissions"),
    schemaVersion: z.literal(1),
    target: z.literal("claude"),
    owned: PermissionSchema,
  })
  .strict();
const empty = (): Permissions => ({ deny: [], ask: [], allow: [] });
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function read(root: string, path: string): { bytes?: Buffer; json?: Record<string, unknown> } {
  const inspected = inspectContainedRelativePath(root, path);
  if (inspected.state === "absent") return {};
  if (inspected.state === "unsafe" || inspected.kind !== "file") {
    throw new AihError(`unsafe command-policy path: ${path}`, "AIH_TRUST");
  }
  const opened = readRegularFileWithStats(inspected.realPath, { maxBytes: MAX_BYTES });
  if (opened?.identity.nlink !== 1n) {
    throw new AihError(`unreadable command-policy path: ${path}`, "AIH_TRUST");
  }
  try {
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(opened.contents),
    );
    if (!isPlainObject(json)) throw new Error("expected object");
    return { bytes: opened.contents, json };
  } catch {
    throw new AihError(`malformed command-policy JSON: ${path}`, "AIH_TRUST");
  }
}

function receipt(root: string): { bytes?: Buffer; owned: Permissions } {
  const record = read(root, COMMAND_PERMISSION_RECEIPT);
  if (!record.json) return { owned: empty() };
  const parsed = ReceiptSchema.safeParse(record.json);
  if (!parsed.success) throw new AihError("invalid command-policy ownership receipt", "AIH_TRUST");
  for (const tier of TIERS) {
    if (new Set(parsed.data.owned[tier]).size !== parsed.data.owned[tier].length) {
      throw new AihError("duplicate command-policy ownership entry", "AIH_TRUST");
    }
  }
  return { bytes: record.bytes, owned: parsed.data.owned };
}

function permissions(document: Record<string, unknown> | undefined): Permissions {
  if (document?.permissions === undefined) return empty();
  if (!isPlainObject(document.permissions))
    throw new AihError("invalid native permissions object", "AIH_TRUST");
  const result = empty();
  for (const tier of TIERS) {
    const parsed = Strings.safeParse(document.permissions[tier] ?? []);
    if (!parsed.success) throw new AihError(`invalid native permissions.${tier}`, "AIH_TRUST");
    result[tier] = parsed.data;
  }
  return result;
}

function desiredPermissions(
  policy: OrgPolicy | undefined,
  targets: readonly string[],
): Permissions {
  if (!policy?.command || !targets.includes("claude")) return empty();
  const command = composeOrgPolicy(policy).command;
  const native = (pattern: string): string => {
    if (/[\r\n\0]/.test(pattern))
      throw new AihError(
        "command pattern has no supported Claude permission representation",
        "AIH_ORG_POLICY",
      );
    return `Bash(${pattern})`;
  };
  return {
    deny: command.deny.map((rule) => native(rule.pattern)),
    ask: command.ask.map((rule) => native(rule.pattern)),
    allow: [...command.safe_read_only, ...command.safe_verification].map((rule) =>
      native(rule.pattern),
    ),
  };
}

export function assertCommandPermissionPolicyPresent(
  root: string,
  policy: OrgPolicy | undefined,
): void {
  if (receipt(root).bytes && !policy) {
    throw new AihError(
      "command-policy ownership remains but policy is missing; restore and reconcile the authorized policy",
      "AIH_ORG_POLICY",
    );
  }
}

export function hasCommandPermissionOwnership(root: string): boolean {
  return receipt(root).bytes !== undefined;
}

export interface CommandPermissionInspection {
  state: "not-requested" | "missing" | "current" | "drifted" | "invalid";
  nativeEnforcement: "unverified";
  advisoryTargets: string[];
  detail: string;
}

export function inspectCommandPermissions(
  root: string,
  policy: OrgPolicy | undefined,
  targets: readonly string[],
): CommandPermissionInspection {
  const advisoryTargets = policy?.command
    ? targets.filter((target) => target !== "claude").sort()
    : [];
  try {
    const previous = receipt(root);
    if (previous.bytes && !policy) {
      return {
        state: "invalid",
        nativeEnforcement: "unverified",
        advisoryTargets,
        detail:
          "Command-policy ownership remains but its selected policy is missing. Restore and reconcile the authorized policy.",
      };
    }
    const desired = desiredPermissions(policy, targets);
    const requested = TIERS.some((tier) => desired[tier].length > 0);
    if (!requested && !previous.bytes)
      return {
        state: "not-requested",
        nativeEnforcement: "unverified",
        advisoryTargets,
        detail: "No native Claude command-rule projection is requested.",
      };
    const live = permissions(read(root, COMMAND_PERMISSION_PATH).json);
    const missing = TIERS.some((tier) =>
      desired[tier].some((value) => !live[tier].includes(value)),
    );
    const drift = TIERS.some((tier) =>
      previous.owned[tier].some(
        (value) => !live[tier].includes(value) || !desired[tier].includes(value),
      ),
    );
    return {
      state: drift ? "drifted" : missing || !previous.bytes ? "missing" : "current",
      nativeEnforcement: "unverified",
      advisoryTargets,
      detail:
        "Native permission entries and ownership are inspected; actual refusal requires a fresh Claude operation. Other selected clients receive advisory command-policy documentation.",
    };
  } catch {
    return {
      state: "invalid",
      nativeEnforcement: "unverified",
      advisoryTargets,
      detail: "Command-policy configuration or ownership cannot be verified safely.",
    };
  }
}

/** Compose one settings write with existing hook writes, preserving every other field. */
export function projectCommandPermissions(
  ctx: PlanContext,
  policy: OrgPolicy,
  targets: readonly string[],
  actions: readonly Action[],
): Action[] {
  const previous = receipt(ctx.root);
  if (!policy.command && !previous.bytes) return [...actions];
  const desired = desiredPermissions(policy, targets);
  const observed = read(ctx.root, COMMAND_PERMISSION_PATH);
  const live = permissions(observed.json);
  const next = empty();
  const owned = empty();
  for (const tier of TIERS) {
    if (previous.owned[tier].some((value) => !live[tier].includes(value))) {
      throw new AihError(
        `command-policy owned permissions.${tier} drifted; preserve custom settings and restore reviewed ownership before retry`,
        "AIH_TRUST",
      );
    }
    const unowned = live[tier].filter((value) => !previous.owned[tier].includes(value));
    owned[tier] = desired[tier].filter((value) => !unowned.includes(value));
    next[tier] = [...new Set([...unowned, ...owned[tier]])];
  }
  const priorWrites = actions.filter(
    (action) => action.kind === "write" && action.path === COMMAND_PERMISSION_PATH,
  );
  if (priorWrites.length > 1)
    throw new AihError("ambiguous native command-policy settings writers", "AIH_TRUST");
  const prior = priorWrites[0];
  if (prior && (prior.kind !== "write" || !isPlainObject(prior.json))) {
    throw new AihError(
      "command-policy cannot compose a non-JSON native settings writer",
      "AIH_TRUST",
    );
  }
  const base = prior?.kind === "write" ? prior : undefined;
  const basePermissions =
    isPlainObject(base?.json) && isPlainObject(base.json.permissions) ? base.json.permissions : {};
  const requested = TIERS.some((tier) => desired[tier].length > 0);
  const result = actions.filter(
    (action) => !(action.kind === "write" && action.path === COMMAND_PERMISSION_PATH),
  );
  if (requested || previous.bytes || base) {
    const write = writeJson(
      COMMAND_PERMISSION_PATH,
      {
        ...(isPlainObject(base?.json) ? base.json : {}),
        permissions: { ...basePermissions, ...next },
      },
      "project organization command rules into native Claude permissions",
      {
        ...(base ?? {}),
        merge: true,
        expect: observed.bytes ? { sha256: hash(observed.bytes) } : { absent: true },
        replaceJsonChildKeys: { ...base?.replaceJsonChildKeys, permissions: TIERS },
      },
    );
    result.push(write);
  }
  if (requested) {
    result.push(
      writeJson(
        COMMAND_PERMISSION_RECEIPT,
        { format: "aih-command-permissions", schemaVersion: 1, target: "claude", owned },
        "record organization command-rule ownership",
        {
          expect: previous.bytes ? { sha256: hash(previous.bytes) } : { absent: true },
        },
      ),
    );
  } else if (previous.bytes) {
    result.push(
      remove(COMMAND_PERMISSION_RECEIPT, "withdraw organization command-rule ownership", {
        hardDelete: true,
        expect: { sha256: hash(previous.bytes) },
      }),
    );
  }
  result.push(
    doc(
      "Organization command-rule effects",
      requested
        ? "The plan projects the selected rules into Claude project permissions; native refusal remains unverified until an actual operation is checked. Command rules for other selected clients remain advisory. Project managed-settings examples require separate administrator deployment."
        : previous.bytes
          ? "The plan withdraws only receipt-owned Claude command rules and preserves unrelated permissions. No native command restriction is applied for the remaining selected clients; their command-policy guidance is advisory."
          : "No native command restriction is applied for the selected clients; command-policy guidance is advisory. Native command-rule projection is supported for Claude. Project managed-settings examples require separate administrator deployment.",
    ),
  );
  return result;
}
