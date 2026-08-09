import { z } from "zod";
import {
  canonicalEccDisabledHookIds,
  ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
  type EccHookControlsSelection,
} from "./ecc-hook-controls.js";
import { HOOK_REGISTRAR_DESTINATION, readGuardedFile } from "./hook-registrar-read.js";
import { OrgPolicyError } from "./schema.js";

export const ECC_HOOK_CONTROLS_RECEIPT_PATH = ".aih/org-policy-ecc-hook-controls-receipt.json";
export const ECC_HOOK_CONTROLS_RECEIPT_FORMAT = "aih-org-policy-ecc-hook-controls-receipt";
const MAX_RECEIPT_BYTES = 64 * 1024;

export interface EccHookControlsReceipt {
  format: typeof ECC_HOOK_CONTROLS_RECEIPT_FORMAT;
  version: 1;
  destination: typeof HOOK_REGISTRAR_DESTINATION;
  sourceContentSha256: typeof ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256;
  profile: EccHookControlsSelection["profile"];
  disabledIds: string[];
}

const ReceiptSchema = z
  .object({
    format: z.literal(ECC_HOOK_CONTROLS_RECEIPT_FORMAT),
    version: z.literal(1),
    destination: z.literal(HOOK_REGISTRAR_DESTINATION),
    sourceContentSha256: z.literal(ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256),
    profile: z.enum(["minimal", "standard", "strict"]),
    disabledIds: z.array(z.string().min(1).max(500)).max(40),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    try {
      const canonical = canonicalEccDisabledHookIds(receipt.disabledIds, receipt.profile);
      if (
        canonical.length !== receipt.disabledIds.length ||
        canonical.some((id, index) => id !== receipt.disabledIds[index])
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["disabledIds"],
          message: "ECC hook-control receipt disabled ids are not in canonical source order",
        });
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["disabledIds"],
        message: error instanceof Error ? error.message : "invalid disabled hook ids",
      });
    }
  });

export function eccHookControlsReceipt(
  selection: EccHookControlsSelection,
): EccHookControlsReceipt {
  return {
    format: ECC_HOOK_CONTROLS_RECEIPT_FORMAT,
    version: 1,
    destination: HOOK_REGISTRAR_DESTINATION,
    sourceContentSha256: ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256,
    profile: selection.profile,
    disabledIds: canonicalEccDisabledHookIds(selection.disabledIds ?? [], selection.profile),
  };
}

export function parseEccHookControlsReceipt(raw: string): EccHookControlsReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OrgPolicyError(
      `${ECC_HOOK_CONTROLS_RECEIPT_PATH} is malformed; refusing ECC hook-control ownership`,
    );
  }
  const parsed = ReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrgPolicyError(
      `${ECC_HOOK_CONTROLS_RECEIPT_PATH} is not an AIH ECC hook-control receipt: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data as EccHookControlsReceipt;
}

export function readEccHookControlsReceipt(
  root: string,
): { receipt: EccHookControlsReceipt; raw: string } | undefined {
  const read = readGuardedFile(root, ECC_HOOK_CONTROLS_RECEIPT_PATH, {
    maxBytes: MAX_RECEIPT_BYTES,
  });
  if (read.state === "unreadable") {
    throw new OrgPolicyError(`refusing ECC hook-control receipt: ${read.reason}`);
  }
  if (read.state === "absent") return undefined;
  return { receipt: parseEccHookControlsReceipt(read.contents), raw: read.contents };
}
