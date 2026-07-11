import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parseDocument } from "yaml";
import type { Check, CheckCode } from "../internals/verify.js";
import { contentFindingFingerprint } from "./fingerprint.js";
import { collectFilesUnder, TRUST_SKIP_DIRS } from "./scan.js";

type AutoExecCode = Extract<CheckCode, "trust.auto-exec-hook">;

const AUTO_EXEC_CODE: AutoExecCode = "trust.auto-exec-hook";
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function linesOf(source: string): string[] {
  return source.split(/\r?\n/);
}

function lineText(source: string, line: number): string {
  return linesOf(source)[line - 1] ?? "";
}

function lineForNeedle(source: string, needle: string): number {
  const lines = linesOf(source);
  const found = lines.findIndex((line) => line.includes(needle));
  return found >= 0 ? found + 1 : 1;
}

function autoExecCheck(path: string, line: number, _lineTextValue: string, detail: string): Check {
  return {
    name: AUTO_EXEC_CODE,
    verdict: "fail",
    detail: `${path}:${line} — ${detail}`,
    code: AUTO_EXEC_CODE,
    location: { uri: path, startLine: line },
  };
}

function fingerprintManifestChecks(root: string, checks: readonly Check[]): Check[] {
  const occurrences = new Map<string, number>();
  return checks.map((check) => {
    const path = check.location?.uri ?? "untrusted-document";
    const line = check.location?.startLine ?? 1;
    const ruleId = check.detail?.split(" — ").at(-1) ?? AUTO_EXEC_CODE;
    let lineContent = "";
    try {
      lineContent = lineText(readFileSync(join(root, path), "utf8"), line);
    } catch {
      lineContent = path;
    }
    const content = `${lineContent}\0${ruleId}`;
    const key = JSON.stringify([AUTO_EXEC_CODE, path, ruleId, content]);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return {
      ...check,
      fingerprint: contentFindingFingerprint({
        code: AUTO_EXEC_CODE,
        path,
        ruleId,
        content,
        occurrence,
        displayLine: line,
      }),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrontmatterDoc(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  if (name === "SKILL.md") return true;
  if (extname(name).toLowerCase() !== ".md") return false;
  return parts.includes("agents") || parts.includes("commands");
}

function isSkillDoc(rel: string): boolean {
  return rel.split("/").at(-1) === "SKILL.md";
}

interface Frontmatter {
  yaml: string;
  endLine: number;
}

function leadingFrontmatter(source: string): Frontmatter | undefined {
  const lines = linesOf(source);
  if (lines[0]?.trim() !== "---") return undefined;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === "---") {
      return {
        yaml: lines.slice(1, index).join("\n"),
        endLine: index + 1,
      };
    }
  }
  return { yaml: lines.slice(1).join("\n"), endLine: 1 };
}

function containsBashWildcard(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .some((part) => part === "Bash" || /^Bash\([^)]*\*[^)]*\)$/.test(part));
  }
  if (Array.isArray(value)) return value.some((item) => containsBashWildcard(item));
  return true;
}

function frontmatterLine(source: string, key: string, fallbackLine: number): number {
  const lines = linesOf(source);
  const found = lines.findIndex(
    (line, index) => index > 0 && line.trimStart().startsWith(`${key}:`),
  );
  return found >= 0 ? found + 1 : fallbackLine;
}

function scanFrontmatter(rel: string, source: string): Check[] {
  const frontmatter = leadingFrontmatter(source);
  if (frontmatter === undefined) return [];
  if (frontmatter.endLine === 1) {
    return [
      autoExecCheck(rel, 1, lineText(source, 1), "unparseable YAML frontmatter in trust document"),
    ];
  }

  const doc = parseDocument(frontmatter.yaml);
  if (doc.errors.length > 0) {
    return [
      autoExecCheck(rel, 1, lineText(source, 1), "unparseable YAML frontmatter in trust document"),
    ];
  }
  let parsed: unknown;
  try {
    parsed = doc.toJS();
  } catch {
    return [
      autoExecCheck(rel, 1, lineText(source, 1), "unparseable YAML frontmatter in trust document"),
    ];
  }
  if (!isRecord(parsed)) return [];

  const checks: Check[] = [];
  if (containsBashWildcard(parsed["allowed-tools"])) {
    const line = frontmatterLine(source, "allowed-tools", 1);
    checks.push(
      autoExecCheck(
        rel,
        line,
        lineText(source, line),
        "frontmatter allowed-tools grants unsafe Bash access",
      ),
    );
  }
  if (parsed.permissionMode === "bypassPermissions") {
    const line = frontmatterLine(source, "permissionMode", 1);
    checks.push(
      autoExecCheck(
        rel,
        line,
        lineText(source, line),
        "frontmatter permissionMode bypasses permissions",
      ),
    );
  }
  if (parsed["dangerously-skip-permissions"] === true) {
    const line = frontmatterLine(source, "dangerously-skip-permissions", 1);
    checks.push(
      autoExecCheck(rel, line, lineText(source, line), "frontmatter dangerously skips permissions"),
    );
  }
  return checks;
}

function skillBodyStartLine(source: string): number {
  const frontmatter = leadingFrontmatter(source);
  if (frontmatter === undefined || frontmatter.endLine === 1) return 1;
  return frontmatter.endLine + 1;
}

function scanBangAutoRun(rel: string, source: string): Check[] {
  const checks: Check[] = [];
  const lines = linesOf(source);
  const startLine = skillBodyStartLine(source);
  for (let index = startLine - 1; index < lines.length; index++) {
    const text = lines[index] ?? "";
    if (/^\s*!(?!\[)/.test(text)) {
      checks.push(
        autoExecCheck(rel, index + 1, text, "SKILL body contains a leading ! auto-run line"),
      );
    }
  }
  return checks;
}

function scanPackageJson(rel: string, source: string): Check[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [autoExecCheck(rel, 1, lineText(source, 1), "unparseable package.json in trust source")];
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];

  const checks: Check[] = [];
  for (const name of Object.keys(parsed.scripts).sort()) {
    if (!LIFECYCLE_SCRIPTS.has(name)) continue;
    const line = lineForNeedle(source, `"${name}"`);
    checks.push(
      autoExecCheck(
        rel,
        line,
        lineText(source, line),
        `package.json lifecycle script ${name} can execute during install/publish`,
      ),
    );
  }
  return checks;
}

function scanNpmrc(rel: string, source: string): Check[] {
  const checks: Check[] = [];
  for (const [index, text] of linesOf(source).entries()) {
    if (/^\s*ignore-scripts\s*=\s*false\s*(?:[#;].*)?$/i.test(text)) {
      checks.push(autoExecCheck(rel, index + 1, text, ".npmrc explicitly enables package scripts"));
    }
  }
  return checks;
}

function scanSettingsHooks(rel: string, source: string): Check[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, "hooks")) return [];
  const line = lineForNeedle(source, '"hooks"');
  return [
    autoExecCheck(
      rel,
      line,
      lineText(source, line),
      "settings file declares hooks that may auto-execute",
    ),
  ];
}

function isSettingsPath(rel: string): boolean {
  return rel === "settings.json" || rel === ".claude/settings.json";
}

function isClaudeHooksDir(rel: string): boolean {
  return rel === ".claude/hooks";
}

function scanHookDirs(root: string): Check[] {
  const checks: Check[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (!st.isDirectory()) return;
    const rel = toPosix(relative(root, abs));
    if (abs !== root && TRUST_SKIP_DIRS.has(basename(abs)) && !isClaudeHooksDir(rel)) return;
    if (isClaudeHooksDir(rel)) {
      checks.push(
        autoExecCheck(rel, 1, rel, ".claude/hooks directory can auto-execute hook commands"),
      );
      return;
    }
    for (const entry of readdirSync(abs)) visit(join(abs, entry));
  };
  visit(root);
  return checks;
}

export function scanTrustManifests(root: string): Check[] {
  const checks: Check[] = [...scanHookDirs(root)];
  for (const abs of collectFilesUnder(root, () => true)) {
    const rel = toPosix(relative(root, abs));
    const name = basename(abs);
    const scansFrontmatter = isFrontmatterDoc(rel);
    const scansSkillBody = isSkillDoc(rel);
    const scansPackage = name === "package.json";
    const scansNpmrc = name === ".npmrc";
    const scansSettings = isSettingsPath(rel);
    if (!scansFrontmatter && !scansSkillBody && !scansPackage && !scansNpmrc && !scansSettings) {
      continue;
    }
    const source = readFileSync(abs, "utf8");
    if (scansFrontmatter) checks.push(...scanFrontmatter(rel, source));
    if (scansSkillBody) checks.push(...scanBangAutoRun(rel, source));
    if (scansPackage) checks.push(...scanPackageJson(rel, source));
    if (scansNpmrc) checks.push(...scanNpmrc(rel, source));
    if (scansSettings) checks.push(...scanSettingsHooks(rel, source));
  }
  return fingerprintManifestChecks(root, checks);
}
