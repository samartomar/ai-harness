import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The subject a Scan run analyzed, recomputed by Core from its own disk
 * (completion evidence v1, C2a §1.6, algorithm subject-files-v1). Scan states
 * `subjectTreeSha256` and `analyzedFileCount` for the files it proved the
 * analyzer received; Core never takes that statement: it rebuilds the same
 * file set from the source root it submitted and compares.
 */
export interface ScanSubjectFileV1 {
  /** Root-relative POSIX path, as Scan's seal records it. */
  readonly path: string;
  /** Lowercase hex sha256 of the file's bytes (a file link: its target's bytes). */
  readonly sha256: string;
}

export interface ScanSubjectDigestV1 {
  readonly subjectTreeSha256: string;
  readonly analyzedFileCount: number;
}

/** Why Core cannot rebuild the subject Scan says it analyzed. */
export class ScanSubjectError extends Error {}

function fail(detail: string): never {
  throw new ScanSubjectError(detail);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fileSha256(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    return fail(`${path} is unreadable (${(error as Error).message})`);
  }
}

/**
 * subject-files-v1: sha256 over, for the files sorted by path in UTF-16
 * code-unit order, `UTF-8(path) 0x00 sha256-hex 0x0A`; the count is the number
 * of files. A duplicate path is refused.
 */
export function scanSubjectDigestV1(files: readonly ScanSubjectFileV1[]): ScanSubjectDigestV1 {
  const ordered = [...files].sort((left, right) => codeUnitCompare(left.path, right.path));
  const hash = createHash("sha256");
  for (const [index, file] of ordered.entries()) {
    if (index > 0 && ordered[index - 1]?.path === file.path)
      fail(`subject file ${file.path} is listed twice`);
    hash.update(`${file.path}\u0000${file.sha256}\n`, "utf8");
  }
  return { subjectTreeSha256: hash.digest("hex"), analyzedFileCount: ordered.length };
}

/** The real target of a link inside the root, or a refusal (broken or escaping). */
function containedTarget(realRoot: string, absolute: string, path: string): string {
  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch {
    return fail(`symbolic link ${path} is broken`);
  }
  const inside = relative(realRoot, real);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    fail(`symbolic link ${path} leaves the source root`);
  return real;
}

function sourceRoots(sourceRoot: string): { readonly root: string; readonly realRoot: string } {
  const root = resolve(sourceRoot);
  try {
    return { root, realRoot: realpathSync.native(root) };
  } catch (error) {
    return fail(`the source root is unavailable (${(error as Error).message})`);
  }
}

/**
 * Every file of the tree as Scan's source seal records it: regular files, and
 * each file link (whose real target stays inside the root) keyed by the link
 * path and hashed over its target. A directory link contributes nothing and is
 * not entered. Anything else (a broken or escaping link, a special file) is
 * refused, as Scan's seal refuses it.
 */
export function sealedScanSubjectFilesV1(sourceRoot: string): ScanSubjectFileV1[] {
  const { root, realRoot } = sourceRoots(sourceRoot);
  const files: ScanSubjectFileV1[] = [];
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      fail(`${prefix || "."} is unreadable (${(error as Error).message})`);
    }
    for (const name of names) {
      const absolute = resolve(directory, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const real = containedTarget(realRoot, absolute, path);
        const target = statSync(real);
        if (target.isFile()) files.push({ path, sha256: fileSha256(real) });
        else if (!target.isDirectory())
          fail(`symbolic link ${path} names neither a file nor a directory`);
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      if (!stat.isFile()) fail(`${path} is neither a file, a directory nor a symbolic link`);
      files.push({ path, sha256: fileSha256(absolute) });
    }
  };
  visit(root, "");
  return files.sort((left, right) => codeUnitCompare(left.path, right.path));
}

/**
 * The named files, as the seal records them. A name that is not in the tree
 * (missing, unsafe, or under a directory link the seal does not enter) is
 * refused; a name that is a directory or a directory link is refused when
 * `required`, else it contributes nothing.
 */
export function namedScanSubjectFilesV1(
  sourceRoot: string,
  paths: readonly string[],
  options: { readonly required: boolean; readonly label: string },
): ScanSubjectFileV1[] {
  const { root, realRoot } = sourceRoots(sourceRoot);
  const files: ScanSubjectFileV1[] = [];
  for (const path of new Set(paths)) {
    const segments = path.split("/");
    if (
      path.length === 0 ||
      path.includes("\\") ||
      path.includes("\u0000") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    )
      fail(`${options.label} ${JSON.stringify(path)} is not a source-relative path`);
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      directory = resolve(directory, segment);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(directory);
      } catch {
        return fail(`${options.label} ${path} is not in the source tree`);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        fail(`${options.label} ${path} is not in the source tree`);
    }
    const absolute = resolve(root, ...segments);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch {
      return fail(`${options.label} ${path} is not in the source tree`);
    }
    let file: string | undefined;
    if (stat.isSymbolicLink()) {
      const real = containedTarget(realRoot, absolute, path);
      const target = statSync(real);
      if (target.isFile()) file = real;
      else if (!target.isDirectory())
        fail(`symbolic link ${path} names neither a file nor a directory`);
    } else if (stat.isFile()) file = absolute;
    else if (!stat.isDirectory())
      fail(`${path} is neither a file, a directory nor a symbolic link`);
    if (file !== undefined) files.push({ path, sha256: fileSha256(file) });
    else if (options.required) fail(`${options.label} ${path} is not a file`);
  }
  return files.sort((left, right) => codeUnitCompare(left.path, right.path));
}

/** Whether a root-relative path lies in the top-level `.git`, which a snapshot leaves out. */
function inGitDirectory(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

/**
 * Detectors whose capability declares `emptySource: "completes"`: only these
 * may state zero analyzed files, and only for an empty subject.
 */
export const SCAN_EMPTY_SOURCE_COMPLETES_V1: ReadonlySet<string> = new Set([
  "detector.semgrep",
  "detector.skillspector",
  "detector.snyk-agent-scan",
  "detector.aih-trust-lint",
  "detector.aih-binding-gate",
]);

/**
 * The file set F a detector run received for a `source-tree` subject (C2a §1.6
 * table), rebuilt from Core's own request: `sealed` is the whole tree, read
 * once per scan and shared across detectors.
 */
export function scanDetectorSubjectFilesV1(
  detectorId: string,
  sourceRoot: string,
  request: {
    readonly selectedClosurePaths: readonly string[];
    readonly mcpConfigPaths?: readonly string[];
    readonly sealed: () => readonly ScanSubjectFileV1[];
  },
): readonly ScanSubjectFileV1[] {
  switch (detectorId) {
    case "detector.semgrep":
    case "detector.skillspector":
      return request.sealed();
    case "detector.snyk-agent-scan":
      return request.sealed().filter((file) => !inGitDirectory(file.path));
    case "detector.cisco": {
      // C2a §3.1: a job is the directory of every selected SKILL.md, the root included.
      const jobs = request.selectedClosurePaths.flatMap((path) =>
        path === "SKILL.md"
          ? [""]
          : path.endsWith("/SKILL.md")
            ? [path.slice(0, -"SKILL.md".length)]
            : [],
      );
      return request
        .sealed()
        .filter(
          (file) =>
            !inGitDirectory(file.path) &&
            jobs.some((job) => job === "" || file.path.startsWith(job)),
        );
    }
    case "detector.cisco-mcp-scanner":
      return namedScanSubjectFilesV1(sourceRoot, request.mcpConfigPaths ?? [], {
        required: false,
        label: "MCP config path",
      });
    case "detector.aih-trust-lint":
    case "detector.aih-binding-gate":
      return namedScanSubjectFilesV1(sourceRoot, request.selectedClosurePaths, {
        required: true,
        label: "selected path",
      });
    default:
      return fail(`Core has no subject rule for ${detectorId}`);
  }
}
