import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PackedMarkdownLinkProblem {
  readonly source: string;
  readonly target: string;
  readonly reason: "missing-directory" | "missing-file" | "missing-fragment" | "unsafe-path";
}

interface PackManifest {
  readonly files?: readonly { readonly path?: unknown }[];
}

function fail(message: string): never {
  throw new Error(`packed documentation check failed: ${message}`);
}

function normalizedPackagePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  )
    fail(`unsafe package path ${JSON.stringify(value)}`);
  return posix.normalize(normalized).replace(/^\.\//u, "");
}

function withoutFencedCode(markdown: string): string {
  let fence: "```" | "~~~" | undefined;
  return markdown
    .split(/\r?\n/gu)
    .map((line) => {
      const marker = /^\s{0,3}(```|~~~)/u.exec(line)?.[1] as "```" | "~~~" | undefined;
      if (marker !== undefined) {
        if (fence === undefined) fence = marker;
        else if (fence === marker) fence = undefined;
        return "";
      }
      return fence === undefined ? line : "";
    })
    .join("\n");
}

function linkTargets(markdown: string): readonly string[] {
  const visible = withoutFencedCode(markdown);
  const targets: string[] = [];
  const inline = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/gu;
  const definitions = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gmu;
  const html = /<(?:a\b[^>]*\bhref|img\b[^>]*\bsrc)\s*=\s*(?:"([^"]+)"|'([^']+)')/giu;
  for (const expression of [inline, definitions, html]) {
    for (const match of visible.matchAll(expression)) {
      const target = match[1] ?? match[2];
      if (target !== undefined && target.length > 0) targets.push(target);
    }
  }
  return targets;
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function withoutInlineHtmlTags(value: string): string {
  const text: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const opening = value.indexOf("<", offset);
    if (opening < 0) {
      text.push(value.slice(offset));
      break;
    }
    text.push(value.slice(offset, opening));
    const closing = value.indexOf(">", opening + 1);
    if (closing < 0) {
      text.push(value.slice(opening));
      break;
    }
    offset = closing + 1;
  }
  return text.join("");
}

function markdownSlug(value: string): string {
  return withoutInlineHtmlTags(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function markdownFragments(markdown: string): ReadonlySet<string> {
  const visible = withoutFencedCode(markdown);
  const fragments = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of visible.split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading !== undefined) {
      const base = markdownSlug(heading);
      if (base.length > 0) {
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        fragments.add(count === 0 ? base : `${base}-${String(count)}`);
      }
    }
    for (const anchor of line.matchAll(/<(?:a|span)\b[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/giu)) {
      const value = decode(anchor[1] ?? "");
      if (value !== undefined && value.length > 0) fragments.add(value);
    }
  }
  return fragments;
}

function absoluteTarget(value: string): boolean {
  return (
    (!/^[A-Za-z]:[\\/]/u.test(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) ||
    value.startsWith("//")
  );
}

export function inspectPackedMarkdownLinks(
  root: string,
  packageFiles: readonly string[],
): readonly PackedMarkdownLinkProblem[] {
  const files = new Set(packageFiles.map(normalizedPackagePath));
  const markdown = [...files].filter((path) => path.toLowerCase().endsWith(".md")).sort();
  const documents = new Map(
    markdown.map(
      (path) => [path, readFileSync(resolve(root, ...path.split("/")), "utf8")] as const,
    ),
  );
  const problems = new Map<string, PackedMarkdownLinkProblem>();

  for (const source of markdown) {
    const sourceDirectory = posix.dirname(source);
    for (const target of linkTargets(documents.get(source) ?? "")) {
      if (absoluteTarget(target)) continue;
      const hashIndex = target.indexOf("#");
      const queryIndex = target.indexOf("?");
      const boundary = Math.min(
        ...[hashIndex, queryIndex].filter((index) => index >= 0),
        target.length,
      );
      const rawPath = target.slice(0, boundary);
      const rawFragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
      const decodedPath = decode(rawPath);
      const decodedFragment = decode(rawFragment);
      const directoryTarget = rawPath.endsWith("/");
      const resolved =
        decodedPath === undefined || decodedPath.length === 0
          ? source
          : posix.normalize(posix.join(sourceDirectory, decodedPath));
      let reason: PackedMarkdownLinkProblem["reason"] | undefined;

      if (
        decodedPath === undefined ||
        decodedFragment === undefined ||
        posix.isAbsolute(decodedPath) ||
        /^[A-Za-z]:[\\/]/u.test(decodedPath) ||
        decodedPath.includes("\\") ||
        resolved === ".." ||
        resolved.startsWith("../")
      ) {
        reason = "unsafe-path";
      } else if (directoryTarget) {
        const prefix = `${resolved.replace(/\/+$/u, "")}/`;
        if (![...files].some((path) => path.startsWith(prefix))) reason = "missing-directory";
      } else if (!files.has(resolved)) {
        reason = "missing-file";
      } else if (
        decodedFragment.length > 0 &&
        resolved.toLowerCase().endsWith(".md") &&
        !markdownFragments(documents.get(resolved) ?? "").has(decodedFragment)
      ) {
        reason = "missing-fragment";
      }

      if (reason !== undefined) {
        const problem = { source, target, reason } as const;
        problems.set(`${source}\0${target}\0${reason}`, problem);
      }
    }
  }

  return [...problems.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source, "en-US") ||
      left.target.localeCompare(right.target, "en-US") ||
      left.reason.localeCompare(right.reason, "en-US"),
  );
}

function packageManifest(root: string): readonly string[] {
  const npmCli = process.env.npm_execpath;
  const command = npmCli === undefined ? "npm" : process.execPath;
  const args = [
    ...(npmCli === undefined ? [] : [npmCli]),
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
  ];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0)
    fail(
      `npm pack dry-run: ${(result.error?.message || result.stderr || result.stdout || "no output").trim()}`,
    );
  let parsed: readonly PackManifest[];
  try {
    parsed = JSON.parse(result.stdout) as readonly PackManifest[];
  } catch {
    fail("npm pack returned non-JSON output");
  }
  const files = Array.isArray(parsed) && parsed.length === 1 ? parsed[0]?.files : undefined;
  if (!Array.isArray(files)) fail("npm pack manifest shape");
  return files.map((entry) => {
    if (typeof entry.path !== "string") fail("npm pack file path");
    return entry.path;
  });
}

export function checkRepositoryPackedMarkdownLinks(root = process.cwd()): void {
  const files = packageManifest(root);
  const problems = inspectPackedMarkdownLinks(root, files);
  if (problems.length > 0) {
    for (const problem of problems)
      process.stderr.write(`${problem.source}: ${problem.reason}: ${problem.target}\n`);
    fail(`${String(problems.length)} unresolved packed Markdown link(s)`);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "PASS", packageFiles: files.length, markdownFiles: files.filter((path) => path.toLowerCase().endsWith(".md")).length })}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    checkRepositoryPackedMarkdownLinks();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "packed documentation check failed"}\n`,
    );
    process.exitCode = 1;
  }
}
