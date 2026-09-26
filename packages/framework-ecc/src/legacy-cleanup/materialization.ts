import {
  type Action,
  type Cli,
  digest,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  readEccMaterializationReceipt,
  remove,
} from "@aihq/core/framework-host";
import { planEccComponentSubtraction } from "./materialization-plan.js";

function targetOf(path: string): Cli | undefined {
  const first = path.split("/")[0];
  const names: Partial<Record<string, Cli>> = {
    ".claude": "claude",
    ".codex": "codex",
    ".cursor": "cursor",
    ".kiro": "kiro",
    ".opencode": "opencode",
    ".gemini": "gemini",
  };
  return names[first ?? ""];
}

/** The installed receipt is the only authority for project-local file subtraction. */
export function materializationPruneActions(
  root: string,
  dropped: readonly Cli[],
  kept?: readonly Cli[],
): Action[] {
  const read = readEccMaterializationReceipt(root);
  if (read.state === "absent") return [];
  if (read.state !== "valid") {
    return [
      digest(
        "Legacy ECC materialization review",
        `${ECC_MATERIALIZATION_RECEIPT_PATH}: ${read.detail}; preserve all claimed destinations`,
        {},
      ),
    ];
  }
  const selected: string[] = [];
  const notes: string[] = [];
  for (const component of read.receipt.components) {
    const targets = component.files.map((file) => targetOf(file.path));
    if (targets.some((target) => target === undefined)) {
      notes.push(
        `${component.id}: destination has no single known CLI owner; preserve for manual review`,
      );
      continue;
    }
    if (
      targets.every(
        (target) =>
          target !== undefined &&
          (dropped.includes(target) || (kept !== undefined && !kept.includes(target))),
      )
    ) {
      selected.push(component.id);
    }
  }
  if (selected.length === 0) {
    return notes.length === 0
      ? []
      : [digest("Legacy ECC materialization review", notes.join("\n"), { notes })];
  }
  let operation: ReturnType<typeof planEccComponentSubtraction>;
  try {
    operation = planEccComponentSubtraction(root, selected);
  } catch (error) {
    return [
      digest(
        "Legacy ECC materialization review",
        `${ECC_MATERIALIZATION_RECEIPT_PATH}: ${(error as Error).message}; preserve selected files`,
        {},
      ),
    ];
  }
  const actions: Action[] = [];
  let unsafeConversion = false;
  for (const step of operation.steps) {
    if (step.kind === "remove") {
      if ("absent" in step.expect) continue;
      actions.push(
        remove(step.path, `subtract unchanged ECC materialization ${step.path}`, {
          hardDelete: true,
          expect: { sha256: step.expect.sha256 },
        }),
      );
      continue;
    }
    if (step.contents === undefined) {
      notes.push(`${step.path}: no exact replacement bytes; preserve for manual review`);
      unsafeConversion = true;
      continue;
    }
    const contents = step.contents.toString("utf8");
    if (!Buffer.from(contents, "utf8").equals(step.contents)) {
      notes.push(`${step.path}: replacement is not UTF-8; preserve for manual review`);
      unsafeConversion = true;
      continue;
    }
    actions.push({
      kind: "write",
      path: step.path,
      describe: `subtract unchanged ECC materialization ${step.path}`,
      contents,
      exactContents: true,
      mode: step.mode,
      expect: "absent" in step.expect ? { absent: true } : { sha256: step.expect.sha256 },
    });
  }
  if (unsafeConversion)
    return [digest("Legacy ECC materialization review", notes.join("\n"), { notes })];
  notes.push(...operation.advisories.map((entry) => `${entry.path}: ${entry.detail}`));
  if (notes.length > 0)
    actions.push(digest("Legacy ECC materialization review", notes.join("\n"), { notes }));
  return actions;
}
