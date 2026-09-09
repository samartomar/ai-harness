import { createHash } from "node:crypto";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
} from "../contract/strict-json-v1.js";
import {
  type EccMaterializationTarget,
  inspectEccTargetDestinationV1,
} from "./materialization-target.js";

const HISTORICAL_ECC_ADAPTER_TARGETS = [
  "claude",
  "codex",
  "cursor",
  "kimi",
  "kiro",
  "opencode",
] as const satisfies readonly EccMaterializationTarget[];

const HISTORICAL_COMPONENT_KINDS = new Set([
  "agent",
  "baseline",
  "capability",
  "framework",
  "lang",
  "mcp",
  "module",
  "runtime",
  "skill",
]);

export interface HistoricalEccAdapterComponentV1 {
  readonly id: string;
  readonly kind: string;
  /** Exact regular files revalidated from the sealed historical source tree. */
  readonly files: readonly { path: string; digest: string }[];
}

export type EccRuntimeAdapterOutcomeV1 =
  | {
      readonly componentId: string;
      readonly path: string;
      readonly target: EccMaterializationTarget;
      readonly state: "mapped";
      readonly scope: "project" | "home";
      readonly relative: string;
    }
  | {
      readonly componentId: string;
      readonly path: string;
      readonly target: EccMaterializationTarget;
      readonly state: "refused";
      readonly reason: string;
    };

export interface EccRuntimeAdapterCompatibilityV1 {
  readonly contractVersion: "ecc-governed-materialization-targets/v1";
  readonly contractDigest: string;
  readonly targets: readonly EccMaterializationTarget[];
  readonly outcomes: readonly EccRuntimeAdapterOutcomeV1[];
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(value)).digest("hex")}`;
}

function safeSourcePath(path: string): boolean {
  if (path.length > 4_000) return false;
  try {
    assertSafeRelativePosixPathV1(path, "historical ECC source file");
    return true;
  } catch {
    return false;
  }
}

function assertComponentShape(component: HistoricalEccAdapterComponentV1): void {
  if (
    !HISTORICAL_COMPONENT_KINDS.has(component.kind) ||
    !component.id.startsWith(`${component.kind}:`)
  ) {
    throw new Error(`unsupported historical ECC component kind: ${component.kind}`);
  }
  if (
    component.files.length === 0 ||
    new Set(component.files.map((file) => file.path)).size !== component.files.length
  ) {
    throw new Error(`invalid historical ECC source files for ${component.id}`);
  }
  for (const file of component.files) {
    if (!safeSourcePath(file.path) || !/^sha256:[a-f0-9]{64}$/.test(file.digest)) {
      throw new Error(`invalid historical ECC source file: ${file.path}`);
    }
  }
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inspectOutcome(
  component: HistoricalEccAdapterComponentV1,
  path: string,
  target: EccMaterializationTarget,
): EccRuntimeAdapterOutcomeV1 {
  // Kiro's governed projection is separately verified and has no descriptor
  // runtime-tree proof today. Refuse it before source acquisition, rather than
  // projecting a guessed historical Kiro mapping.
  if (target === "kiro") {
    return {
      componentId: component.id,
      path,
      target,
      state: "refused",
      reason: "historical-kiro-runtime-proof-unavailable",
    };
  }
  const outcome = inspectEccTargetDestinationV1(path, target);
  return outcome.state === "mapped"
    ? {
        componentId: component.id,
        path,
        target,
        state: "mapped",
        scope: outcome.scope,
        relative: outcome.relative,
      }
    : {
        componentId: component.id,
        path,
        target,
        state: "refused",
        reason: outcome.reason,
      };
}

function orderedComponents(
  components: readonly HistoricalEccAdapterComponentV1[],
): HistoricalEccAdapterComponentV1[] {
  const ids = new Set<string>();
  const ordered = [...components].sort((left, right) => byCodeUnit(left.id, right.id));
  for (const component of ordered) {
    assertComponentShape(component);
    if (ids.has(component.id))
      throw new Error(`duplicate historical ECC component: ${component.id}`);
    ids.add(component.id);
  }
  return ordered;
}

function outcomesFor(
  components: readonly HistoricalEccAdapterComponentV1[],
): EccRuntimeAdapterOutcomeV1[] {
  return orderedComponents(components).flatMap((component) =>
    [...component.files]
      .sort((left, right) => byCodeUnit(left.path, right.path))
      .flatMap((file) =>
        HISTORICAL_ECC_ADAPTER_TARGETS.map((target) =>
          inspectOutcome(component, file.path, target),
        ),
      ),
  );
}

function compatibilityContractV1(components: readonly HistoricalEccAdapterComponentV1[]) {
  return {
    contractVersion: "ecc-governed-materialization-targets/v1" as const,
    relationContract: "compiled-requires-members-and-riders/v1",
    targets: [...HISTORICAL_ECC_ADAPTER_TARGETS],
    outcomes: outcomesFor(components),
  };
}

/**
 * The exact target and closure behavior this Core can apply to a sealed
 * historical ECC descriptor. Every verified regular file is inspected through
 * the same closed target resolver used by materialization; no source bytes are
 * read here.
 */
export function currentEccRuntimeAdapterCompatibilityV1(
  components: readonly HistoricalEccAdapterComponentV1[],
): EccRuntimeAdapterCompatibilityV1 {
  const contract = compatibilityContractV1(components);
  return Object.freeze({
    contractVersion: contract.contractVersion,
    contractDigest: sha256(contract),
    targets: Object.freeze([...contract.targets]),
    outcomes: Object.freeze(contract.outcomes.map((outcome) => Object.freeze({ ...outcome }))),
  });
}

function sameCompatibility(
  left: EccRuntimeAdapterCompatibilityV1,
  right: EccRuntimeAdapterCompatibilityV1,
): boolean {
  return canonicalStrictJsonBytesV1(left).equals(canonicalStrictJsonBytesV1(right));
}

/**
 * Refuse before acquisition unless this Core still has the exact closed target
 * mapping and relation semantics the descriptor was sealed for. The proof
 * grants no evidence result or approval; the baseline verifier still rehashes
 * and authorizes the exact acquired source.
 */
export function assertHistoricalEccAdapterCompatibilityV1(
  compatibility: EccRuntimeAdapterCompatibilityV1,
  components: readonly HistoricalEccAdapterComponentV1[],
): void {
  const expected = currentEccRuntimeAdapterCompatibilityV1(components);
  if (!sameCompatibility(compatibility, expected)) {
    throw new Error("historical ECC runtime adapter compatibility does not match this Core");
  }
}
