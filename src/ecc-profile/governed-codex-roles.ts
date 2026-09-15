import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { readContainedRegularFile } from "../internals/contained-path.js";
import { removeManagedBlock, upsertTextBlock } from "../internals/envfile.js";
import { type Plan, plan, remove, writeJson, writeText } from "../internals/plan.js";
import { beginMarker, endMarker } from "../internals/render.js";

export const GOVERNED_CODEX_ROLE_SCOPE = "ecc-governed-codex-roles";
export const GOVERNED_CODEX_ROLE_RECEIPT = ".aih/ecc/codex-role-registration-v1.json";
const CONFIG = ".codex/config.toml";
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const RoleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    description: z.string().min(1).max(1_024),
    configFile: z.string().regex(/^\.codex\/agents\/[a-z0-9][a-z0-9_-]*\.toml$/),
  })
  .strict();
const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    canonicalRoot: z.string().min(1),
    blockSha256: z.string().regex(/^[a-f0-9]{64}$/),
    roles: z.array(RoleSchema).max(512),
  })
  .strict();

export type GovernedCodexRole = z.infer<typeof RoleSchema>;
export interface GovernedCodexRoleRegistrationInspection {
  state: "current" | "missing" | "drifted" | "conflict" | "malformed";
  expectedRoleIds: string[];
  receiptRoleIds: string[];
  detail?: string;
}

/** Exact prior owned roles retained only for transactional compensation. */
export function governedCodexRoleReceiptRoles(root: string): GovernedCodexRole[] {
  const raw = read(root, GOVERNED_CODEX_ROLE_RECEIPT);
  return raw === undefined ? [] : ReceiptSchema.parse(JSON.parse(raw)).roles;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function read(root: string, path: string): string | undefined {
  const opened = readContainedRegularFile(root, path, { maxBytes: MAX_CONFIG_BYTES });
  if (opened.state === "absent") return undefined;
  if (opened.state !== "present" || opened.stats.nlink !== 1)
    throw new Error(`governed Codex role file is not a safe bounded regular file: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(opened.contents);
  } catch {
    throw new Error(`governed Codex role file is not valid UTF-8: ${path}`);
  }
}

function block(contents: string): string | undefined {
  const begin = beginMarker(GOVERNED_CODEX_ROLE_SCOPE);
  const end = endMarker(GOVERNED_CODEX_ROLE_SCOPE);
  const start = contents.indexOf(begin);
  if (start < 0) return undefined;
  if (contents.indexOf(begin, start + begin.length) >= 0)
    throw new Error("duplicate governed Codex role blocks");
  const finish = contents.indexOf(end, start + begin.length);
  if (finish < 0 || contents.indexOf(end, finish + end.length) >= 0)
    throw new Error("malformed governed Codex role block");
  return contents.slice(start, finish + end.length);
}

function assertOwnedBlockTerminatesConfig(contents: string, ownedBlock: string): void {
  const suffix = contents.slice(contents.indexOf(ownedBlock) + ownedBlock.length);
  const significant = suffix
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (significant !== undefined && !significant.startsWith("["))
    throw new Error(
      "Codex config content after the governed role block has ambiguous TOML table scope",
    );
}

function body(roles: readonly GovernedCodexRole[]): string {
  return roles
    .flatMap((role) => [
      `[agents.${role.id}]`,
      `description = ${JSON.stringify(role.description)}`,
      `config_file = ${JSON.stringify(role.configFile.slice(".codex/".length))}`,
      "",
    ])
    .join("\n")
    .trimEnd();
}

function semanticAgentNames(contents: string): Set<string> {
  if (contents.trim().length === 0) return new Set();
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch (error) {
    throw new Error(`Codex config TOML is invalid: ${(error as Error).message}`);
  }
  const agents = (parsed as { agents?: unknown }).agents;
  if (agents === undefined) return new Set();
  if (agents === null || typeof agents !== "object" || Array.isArray(agents))
    throw new Error("Codex config agents value is not a table");
  return new Set(Object.keys(agents as Record<string, unknown>));
}

/** Read-only native registration evidence for delivery/readiness reports. */
export function inspectGovernedCodexRoleRegistration(
  root: string,
  rawExpectedRoles: readonly Pick<GovernedCodexRole, "id" | "configFile">[],
): GovernedCodexRoleRegistrationInspection {
  const expected = rawExpectedRoles
    .map((role) =>
      RoleSchema.pick({ id: true, configFile: true }).parse({
        id: role.id,
        configFile: role.configFile,
      }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedRoleIds = expected.map((role) => role.id).sort();
  let rawReceipt: string | undefined;
  try {
    rawReceipt = read(root, GOVERNED_CODEX_ROLE_RECEIPT);
  } catch (error) {
    return {
      state: "malformed",
      expectedRoleIds,
      receiptRoleIds: [],
      detail: (error as Error).message,
    };
  }
  if (rawReceipt === undefined && expected.length === 0)
    return { state: "current", expectedRoleIds, receiptRoleIds: [] };
  let current: string;
  try {
    current = read(root, CONFIG) ?? "";
  } catch (error) {
    return {
      state: "malformed",
      expectedRoleIds,
      receiptRoleIds: [],
      detail: (error as Error).message,
    };
  }
  if (rawReceipt === undefined) {
    try {
      if (block(current) !== undefined)
        return { state: "drifted", expectedRoleIds, receiptRoleIds: [] };
      const conflicts = expectedRoleIds.filter((id) => semanticAgentNames(current).has(id));
      if (conflicts.length > 0)
        return {
          state: "conflict",
          expectedRoleIds,
          receiptRoleIds: [],
          detail: `existing agents: ${conflicts.join(", ")}`,
        };
    } catch (error) {
      return {
        state: "malformed",
        expectedRoleIds,
        receiptRoleIds: [],
        detail: (error as Error).message,
      };
    }
    return {
      state: expected.length === 0 ? "current" : "missing",
      expectedRoleIds,
      receiptRoleIds: [],
    };
  }
  let receipt: z.infer<typeof ReceiptSchema>;
  try {
    receipt = ReceiptSchema.parse(JSON.parse(rawReceipt));
  } catch (error) {
    return {
      state: "malformed",
      expectedRoleIds,
      receiptRoleIds: [],
      detail: (error as Error).message,
    };
  }
  const receiptRoleIds = receipt.roles.map((role) => role.id).sort();
  try {
    const ownedBlock = block(current);
    if (
      receipt.canonicalRoot !== realpathSync(root) ||
      ownedBlock === undefined ||
      sha256(ownedBlock) !== receipt.blockSha256 ||
      JSON.stringify(receipt.roles.map(({ id, configFile }) => ({ id, configFile }))) !==
        JSON.stringify(expected) ||
      block(upsertTextBlock("", GOVERNED_CODEX_ROLE_SCOPE, body(receipt.roles)))?.replace(
        /\r\n/g,
        "\n",
      ) !== ownedBlock.replace(/\r\n/g, "\n")
    )
      return { state: "drifted", expectedRoleIds, receiptRoleIds };
    assertOwnedBlockTerminatesConfig(current, ownedBlock);
    semanticAgentNames(current);
    return { state: "current", expectedRoleIds, receiptRoleIds };
  } catch (error) {
    return { state: "drifted", expectedRoleIds, receiptRoleIds, detail: (error as Error).message };
  }
}

/** Ownership-safe project registration for only the governed selected Codex roles. */
export function planGovernedCodexRoleRegistration(
  root: string,
  rawRoles: readonly GovernedCodexRole[],
): Plan {
  const roles = rawRoles
    .map((role) => RoleSchema.parse(role))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(roles.map((role) => role.id)).size !== roles.length)
    throw new Error("governed Codex role registration contains duplicate role ids");
  const canonicalRoot = realpathSync(root);
  const rawReceipt = read(root, GOVERNED_CODEX_ROLE_RECEIPT);
  // A non-Codex governed run has no ownership claim over this file. It must not
  // parse or reject an unrelated operator config merely because no receipt exists.
  if (roles.length === 0 && rawReceipt === undefined)
    return plan("ecc: governed Codex role registration");
  const receipt =
    rawReceipt === undefined ? undefined : ReceiptSchema.parse(JSON.parse(rawReceipt));
  const currentRaw = read(root, CONFIG);
  const current = currentRaw ?? "";
  if (receipt !== undefined && receipt.canonicalRoot !== canonicalRoot)
    throw new Error("governed Codex role receipt belongs to another root");
  const ownedBlock = block(current);
  if (receipt === undefined && ownedBlock !== undefined)
    throw new Error("governed Codex role block has no ownership receipt");
  if (
    receipt !== undefined &&
    (ownedBlock === undefined || sha256(ownedBlock) !== receipt.blockSha256)
  )
    throw new Error("governed Codex role block drifted from its ownership receipt");
  if (ownedBlock !== undefined) assertOwnedBlockTerminatesConfig(current, ownedBlock);
  const base =
    receipt === undefined ? current : removeManagedBlock(current, GOVERNED_CODEX_ROLE_SCOPE);
  const existing = semanticAgentNames(base);
  const collisions = roles.map((role) => role.id).filter((id) => existing.has(id));
  if (collisions.length > 0)
    throw new Error(
      `governed Codex role registration conflicts with existing agents: ${collisions.join(", ")}`,
    );
  if (roles.length === 0) {
    if (receipt === undefined) return plan("ecc: governed Codex role registration");
    const actions = [];
    if (base.trim().length === 0)
      actions.push(
        remove(CONFIG, "withdraw governed Codex role registration", {
          expect: { sha256: sha256(current) },
        }),
      );
    else
      actions.push(
        writeText(CONFIG, base, "withdraw governed Codex role registration", {
          expect: { sha256: sha256(current) },
        }),
      );
    actions.push(
      remove(GOVERNED_CODEX_ROLE_RECEIPT, "withdraw governed Codex role receipt", {
        expect: { sha256: sha256(rawReceipt ?? "") },
      }),
    );
    return plan("ecc: governed Codex role registration", ...actions);
  }
  const next = upsertTextBlock(base, GOVERNED_CODEX_ROLE_SCOPE, body(roles));
  // A pre-existing inline/dotted table can make an appended header invalid even
  // when its agent names do not collide. Parse the complete candidate before it
  // becomes an action so table-extension ambiguity fails closed.
  semanticAgentNames(next);
  const nextBlock = block(next);
  if (nextBlock === undefined)
    throw new Error("governed Codex role registration produced no managed block");
  return plan(
    "ecc: governed Codex role registration",
    writeText(CONFIG, next, "register governed selected Codex roles", {
      expect: currentRaw === undefined ? { absent: true } : { sha256: sha256(current) },
    }),
    writeJson(
      GOVERNED_CODEX_ROLE_RECEIPT,
      { schemaVersion: 1, canonicalRoot, blockSha256: sha256(nextBlock), roles },
      "record governed Codex role registration ownership",
      { expect: rawReceipt === undefined ? { absent: true } : { sha256: sha256(rawReceipt) } },
    ),
  );
}
