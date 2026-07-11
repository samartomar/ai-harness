import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import { AihError } from "../errors.js";
import type {
  ContingentEccInstallOperation,
  EccInstallPreviewArtifact,
} from "./install-preview.js";

const HARNESS_GENERATED_SOURCE = "aih ledger-last writer";
const INSTALL_TARGETS = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "zed",
] as const;

function operationKey(operation: ContingentEccInstallOperation): string {
  return [
    operation.target,
    operation.componentId,
    operation.kind,
    operation.destination,
    operation.source ?? "",
  ].join("\0");
}

function assertSourceFile(eccRoot: string, source: string | undefined): void {
  if (source === undefined || source === HARNESS_GENERATED_SOURCE) return;
  if (isAbsolute(source))
    throw new AihError("ECC install preview source must be relative", "AIH_CONFIG");
  const root = realpathSync(eccRoot);
  const candidate = resolve(root, source);
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new AihError("ECC install preview source escapes the pinned checkout", "AIH_CONFIG");
  }
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AihError(`ECC install preview source is not a regular file: ${source}`, "AIH_CONFIG");
  }
}

export function validateEccInstallPreviewArtifact(
  eccRoot: string,
  catalog: BaselineCatalog,
  artifact: EccInstallPreviewArtifact,
): void {
  if (
    artifact.source.owner !== catalog.owner ||
    artifact.source.repo !== catalog.repo ||
    artifact.source.pinnedSha !== catalog.pinnedSha
  ) {
    throw new AihError("ECC install preview is not bound to the active catalog pin", "AIH_CONFIG");
  }
  let prior = "";
  for (const operation of artifact.operations) {
    const key = operationKey(operation);
    if (prior.length > 0 && key.localeCompare(prior) < 0)
      throw new AihError("ECC install preview operations are not sorted", "AIH_CONFIG");
    prior = key;
    assertSourceFile(eccRoot, operation.source);
  }
  for (const target of INSTALL_TARGETS) {
    if (
      !artifact.operations.some(
        (operation) =>
          operation.target === target &&
          operation.kind === "exec" &&
          operation.componentId === "runtime:ecc-installer",
      )
    ) {
      throw new AihError(`ECC install preview is missing the ${target} runtime`, "AIH_CONFIG");
    }
  }
  if (
    !artifact.operations.some(
      (operation) => operation.target === "kiro" && operation.componentId === "runtime:ecc-kiro",
    )
  ) {
    throw new AihError("ECC install preview is missing the Kiro runtime", "AIH_CONFIG");
  }
}
