import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readIfExists } from "./fsxn.js";

/**
 * A repo display name for generated canon headings (RULE_ROUTER + bootloader
 * preambles) that is STABLE across checkout locations. Deriving it from the
 * checkout folder's basename made `bootstrap-ai --verify` environment-sensitive:
 * the drift probe regenerates content in the CURRENT checkout, so a renamed
 * clone or a `git worktree` checkout false-failed with `canon.generated-drift`.
 *
 * Derivation chain, failing SOFT at every step (this is a display name, never a
 * gate input):
 *   1. the git `origin` remote URL's repo segment — `.git/config` is read
 *      directly (never a `git` subprocess); a worktree's `.git` pointer FILE is
 *      resolved through `gitdir:` and `commondir` to the main checkout's config;
 *   2. `package.json` `name`, npm scope stripped;
 *   3. `basename(resolve(root))` (resolve first: basename(".") is ".");
 *   4. "this repo".
 */
export function repoDisplayName(root: string): string {
  const origin = originRepoSegment(root);
  if (origin !== undefined) return origin;
  const pkg = packageName(root);
  if (pkg !== undefined) return pkg;
  const base = basename(resolve(root));
  return base.length > 0 ? base : "this repo";
}

/**
 * Never throw for a mere display name: `readIfExists` still raises for an
 * exists-but-unreadable path (e.g. a DIRECTORY named `package.json` → EISDIR).
 */
function readTextIfFile(path: string): string | undefined {
  try {
    return readIfExists(path);
  } catch {
    return undefined;
  }
}

/**
 * The repo segment of the `origin` remote URL, or `undefined` when unavailable.
 * Reads the literal `url` value; `url.<base>.insteadOf` rewriting is deliberately
 * not applied — it rewrites scheme/host prefixes, which never change the trailing
 * repo segment extracted here.
 */
function originRepoSegment(root: string): string | undefined {
  const commonDir = gitCommonDir(root);
  if (commonDir === undefined) return undefined;
  const config = readTextIfFile(join(commonDir, "config"));
  if (config === undefined) return undefined;
  const url = originUrl(config);
  return url === undefined ? undefined : repoSegment(url);
}

/**
 * The directory holding the repo's shared `config`: `.git/` itself, or — when
 * `.git` is a worktree/submodule POINTER FILE — the `gitdir:` target, walked
 * back through `commondir` to the main checkout's git dir.
 */
function gitCommonDir(root: string): string | undefined {
  const gitPath = join(root, ".git");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(gitPath);
  } catch {
    return undefined;
  }
  let gitDir: string;
  if (stats.isDirectory()) {
    gitDir = gitPath;
  } else {
    const target = /^gitdir:\s*(.+)$/m.exec(readTextIfFile(gitPath) ?? "")?.[1]?.trim();
    if (target === undefined || target.length === 0) return undefined;
    gitDir = resolve(root, target);
  }
  const common = readTextIfFile(join(gitDir, "commondir"))?.trim();
  return common === undefined || common.length === 0 ? gitDir : resolve(gitDir, common);
}

/**
 * The `url` of `[remote "origin"]` from git-config INI text, if declared. The
 * section KEYWORD is case-insensitive but the quoted subsection name is not
 * (git-config semantics: `[REMOTE "origin"]` matches, `[remote "ORIGIN"]` is a
 * different remote). Values un-quote and drop inline `#`/`;` comments.
 */
function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const section = /^\[(\w+)\s+"(.*)"\]$/.exec(line);
      inOrigin = section?.[1]?.toLowerCase() === "remote" && section?.[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const url = configValue(/^url\s*=\s*(.+)$/i.exec(line)?.[1] ?? "");
    if (url !== undefined) return url;
  }
  return undefined;
}

/**
 * A git-config VALUE from its raw right-hand side: a leading-quoted value keeps
 * everything to the closing quote; an unquoted one ends at the first `#`/`;`
 * inline comment. Git starts the comment at ANY unquoted `#`/`;` — no preceding
 * whitespace required (`git config -f` on `url = https://…/re#po.git` yields
 * `https://…/re`) — so the unconditional split below matches git exactly.
 * Best-effort (no escape handling) — a miss falls back soft.
 */
function configValue(rhs: string): string | undefined {
  const trimmed = rhs.trim();
  const value = trimmed.startsWith('"')
    ? (/^"([^"]*)"/.exec(trimmed)?.[1] ?? "")
    : (trimmed.split(/[#;]/)[0] ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The final path segment of a remote URL, `.git` suffix stripped. Splitting on
 * `/`, `\` and `:` covers https, ssh://, scp-style (`git@host:user/repo`) and
 * local-path remotes alike.
 */
function repoSegment(url: string): string | undefined {
  const stripped = url.replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const segment = stripped.split(/[/\\:]/).pop() ?? "";
  return segment.length > 0 && segment !== "." && segment !== ".." ? segment : undefined;
}

/** `package.json` `name` with any npm scope stripped, or `undefined`. */
function packageName(root: string): string | undefined {
  const raw = readTextIfFile(join(root, "package.json"));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== "string") return undefined;
  const unscoped = (name.startsWith("@") ? (name.split("/")[1] ?? "") : name).trim();
  return unscoped.length > 0 ? unscoped : undefined;
}
