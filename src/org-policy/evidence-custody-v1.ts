import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { FileAssertion } from "../internals/plan.js";

/** The organization evidence envelope has the same fixed hostile-input ceiling as its parser. */
export const MAX_POLICY_RESOLVE_EVIDENCE_BYTES_V1 = 4_096;

export interface CustodiedEvidenceV1 {
  readonly bytes: Buffer;
  /** Read-only transaction pin for these exact, root-contained evidence bytes. */
  readonly assertion: FileAssertion;
  /** Re-read from the same non-symlinked path after an external verifier returns. */
  unchanged(): boolean;
}

export type EvidenceCustodyResultV1 =
  | { evidence: CustodiedEvidenceV1 }
  | { problem: "invalid-evidence-path" | "unsafe-evidence-custody" | "evidence-unavailable" };

function relativeEvidencePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return undefined;
  return value;
}

/** @internal Pure containment guard; intentionally not exported from the package root. */
export function isContainedEvidenceRelativePathV1(pathRelative: string): boolean {
  return (
    pathRelative !== "" &&
    !isAbsolute(pathRelative) &&
    !win32.isAbsolute(pathRelative) &&
    !pathRelative.split(/[\\/]+/).some((part) => part === "" || part === "." || part === "..")
  );
}

function hasSymlinkedParent(root: string, path: string): boolean {
  const rootStat = safeLstat(root);
  if (rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return true;
  let current = root;
  const pathRelative = relative(root, path);
  if (!isContainedEvidenceRelativePathV1(pathRelative)) return true;
  for (const part of pathRelative.split(sep).slice(0, -1)) {
    current = resolve(current, part);
    const stat = safeLstat(current);
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return true;
  }
  return false;
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Acquire only a regular, root-contained evidence file. The returned closure
 * proves that the exact bytes and file identity survived any later authority
 * verifier process before those bytes can mint a qualification capability.
 */
export function custodyOrganizationEvidenceV1(
  root: string,
  requestedPath: unknown,
): EvidenceCustodyResultV1 {
  const rel = relativeEvidencePath(requestedPath);
  if (rel === undefined) return { problem: "invalid-evidence-path" };
  const path = resolve(root, rel);
  const pathRelative = relative(root, path);
  if (!isContainedEvidenceRelativePathV1(pathRelative)) {
    return { problem: "invalid-evidence-path" };
  }
  if (hasSymlinkedParent(root, path)) return { problem: "unsafe-evidence-custody" };
  const opened = readRegularFileWithStats(path, { maxBytes: MAX_POLICY_RESOLVE_EVIDENCE_BYTES_V1 });
  if (opened === undefined) {
    const stat = safeLstat(path);
    return stat?.isSymbolicLink()
      ? { problem: "unsafe-evidence-custody" }
      : { problem: "evidence-unavailable" };
  }
  const original = Buffer.from(opened.contents);
  const identity = { dev: opened.stats.dev, ino: opened.stats.ino, size: opened.stats.size };
  return {
    evidence: {
      bytes: original,
      assertion: {
        path: rel,
        sha256: createHash("sha256").update(original).digest("hex"),
        maxBytes: MAX_POLICY_RESOLVE_EVIDENCE_BYTES_V1,
        describe: "assert qualified organization evidence remains exact",
      },
      unchanged(): boolean {
        if (hasSymlinkedParent(root, path)) return false;
        const current = readRegularFileWithStats(path, {
          maxBytes: MAX_POLICY_RESOLVE_EVIDENCE_BYTES_V1,
        });
        return (
          current !== undefined &&
          current.stats.dev === identity.dev &&
          current.stats.ino === identity.ino &&
          current.stats.size === identity.size &&
          current.contents.equals(original)
        );
      },
    },
  };
}
