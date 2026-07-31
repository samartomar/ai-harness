import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;

export interface OutputManifestEntry {
  path: string;
  sha256: string;
}

export interface OutputManifestVerification {
  ok: true;
  entries: OutputManifestEntry[];
}

function safeOutputPath(root: string, value: string): string {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`unsafe output-manifest path: ${JSON.stringify(value)}`);
  }
  const absolute = normalize(join(root, value));
  const fromRoot = relative(normalize(root), absolute);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`output-manifest path escapes root: ${JSON.stringify(value)}`);
  }
  return absolute;
}

function fileSha256(path: string): string {
  const inspected = lstatSync(path);
  if (!inspected.isFile() || inspected.isSymbolicLink()) {
    throw new Error(`output-manifest entry is not a regular file: ${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parseOutputManifest(text: string): OutputManifestEntry[] {
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0);
  const entries = rows.map((line, index) => {
    const match = /^([0-9a-f]{64}) {2}([^\r\n]+)$/.exec(line);
    if (match === null || !SHA256.test(match[1] ?? "")) {
      throw new Error(`malformed output-manifest row ${index + 1}`);
    }
    return { sha256: match[1] as string, path: match[2] as string };
  });
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`duplicate output-manifest path: ${entry.path}`);
    paths.add(entry.path);
  }
  return entries;
}

export function verifyOutputManifest(
  root: string,
  manifestText: string,
): OutputManifestVerification {
  const absoluteRoot = resolve(root);
  const entries = parseOutputManifest(manifestText);
  if (entries.length === 0) throw new Error("output manifest must contain at least one entry");
  const realRoot = realpathSync(absoluteRoot);
  for (const entry of entries) {
    const candidate = safeOutputPath(absoluteRoot, entry.path);
    const realCandidate = realpathSync(candidate);
    const fromRealRoot = relative(realRoot, realCandidate);
    if (fromRealRoot.length === 0 || fromRealRoot.startsWith("..") || isAbsolute(fromRealRoot)) {
      throw new Error(`output-manifest path resolves outside root: ${entry.path}`);
    }
    const actual = fileSha256(realCandidate);
    if (actual !== entry.sha256) {
      throw new Error(
        `output-manifest digest mismatch for ${entry.path}: expected ${entry.sha256}, actual ${actual}`,
      );
    }
  }
  return { ok: true, entries };
}

export function writeVerifiedOutputManifest(input: {
  root: string;
  manifestPath: string;
  outputPaths: readonly string[];
}): OutputManifestVerification {
  const absoluteRoot = resolve(input.root);
  const absoluteManifest = resolve(input.manifestPath);
  const fromRoot = relative(absoluteRoot, absoluteManifest);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("output manifest must be written inside its output root");
  }
  const realRoot = realpathSync(absoluteRoot);
  const realParent = realpathSync(dirname(absoluteManifest));
  const canonicalManifest = join(realParent, basename(absoluteManifest));
  const realParentFromRoot = relative(realRoot, realParent);
  if (realParentFromRoot.startsWith("..") || isAbsolute(realParentFromRoot)) {
    throw new Error("output manifest parent resolves outside its output root");
  }
  try {
    const existing = lstatSync(canonicalManifest);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("output manifest target must be a regular file");
    }
    const realManifest = realpathSync(canonicalManifest);
    const realManifestFromRoot = relative(realRoot, realManifest);
    if (realManifestFromRoot.startsWith("..") || isAbsolute(realManifestFromRoot)) {
      throw new Error("output manifest target resolves outside its output root");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const paths = [...new Set(input.outputPaths)].sort((left, right) => left.localeCompare(right));
  if (paths.length !== input.outputPaths.length) {
    throw new Error("output manifest contains duplicate requested paths");
  }
  if (paths.some((path) => safeOutputPath(absoluteRoot, path) === absoluteManifest)) {
    throw new Error("output manifest cannot hash itself");
  }
  const entries = paths.map((path) => ({
    path,
    sha256: fileSha256(safeOutputPath(absoluteRoot, path)),
  }));
  const text = `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
  const temporaryManifest = join(realParent, `.aih-manifest-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryManifest, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryManifest, canonicalManifest);
  } catch (error) {
    try {
      unlinkSync(temporaryManifest);
    } catch {
      // The temp was never created or the successful rename already consumed it.
    }
    throw error;
  }
  return verifyOutputManifest(absoluteRoot, readFileSync(canonicalManifest, "utf8"));
}
