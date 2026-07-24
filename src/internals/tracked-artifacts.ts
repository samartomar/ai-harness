export interface TrackedArtifactViolation {
  path: string;
  reason: string;
}

function normalizeTrackedPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function forbiddenReason(path: string): string | undefined {
  if (path === "node_modules" || path.startsWith("node_modules/")) {
    return "dependency install output";
  }
  if (path === "dist" || path.startsWith("dist/")) {
    return "build output";
  }
  if (path === "coverage" || path.startsWith("coverage/")) {
    return "coverage output";
  }
  if (path.endsWith(".tsbuildinfo")) {
    return "TypeScript incremental cache";
  }
  if (path === ".aih" || path.startsWith(".aih/")) {
    return ".aih runtime data; nothing under .aih may be tracked";
  }
  return undefined;
}

export function findTrackedArtifactViolations(paths: Iterable<string>): TrackedArtifactViolation[] {
  const violations: TrackedArtifactViolation[] = [];
  for (const rawPath of paths) {
    const path = normalizeTrackedPath(rawPath);
    if (path.length === 0) continue;
    const reason = forbiddenReason(path);
    if (reason) violations.push({ path, reason });
  }
  return violations;
}

export function formatTrackedArtifactViolations(
  violations: readonly TrackedArtifactViolation[],
): string {
  const shown = violations.slice(0, 40);
  const remaining = violations.length - shown.length;
  const listed = shown.map((v) => `  - ${v.path} (${v.reason})`);
  return [
    "Tracked generated artifacts are forbidden.",
    "",
    ...listed,
    ...(remaining > 0 ? [`  ...and ${remaining} more`] : []),
    "",
    "Remove them from the Git index only; keep the real files on disk:",
    "  git rm --cached <path>",
    "  git rm -r --cached node_modules dist coverage",
    "",
    "Then confirm .gitignore covers the path before committing.",
  ].join("\n");
}
