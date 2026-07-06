import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { INCOMING_MCP_CONFIG_FILES } from "../trust/scan.js";
import { isScriptLikeFilePath } from "../trust/script-files.js";
import { collectSkillDirs, promotedSkillRel } from "../workspace/acquire.js";

/**
 * Pure-fs shape record for an external skill source — the verdict engine's
 * structural input. Every field is derived by reading the tree; nothing here
 * spawns, writes, or contacts a remote system.
 */
export interface SkillShape {
  /** Logical skill names for every directory holding a SKILL.md. */
  skillDirs: string[];
  /** Install lifecycle hooks in package.json, or shell/install scripts at root or root/scripts. */
  installScripts: boolean;
  /** Exact source-relative files that made installScripts applicable, when known. */
  installScriptFiles?: string[];
  /** An incoming MCP config file is present in the tree. */
  mcpConfig: boolean;
  /** Exact source-relative incoming MCP config files, when known. */
  mcpConfigFiles?: string[];
  /** Package manifests found at the tree root or inside skill directories. */
  packageManifests: string[];
  /** Skill docs advertise scanning/analyzing the whole repository. */
  fullCodebaseAnalysis: boolean;
}

const PACKAGE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];

const INSTALL_SCRIPT_HOOKS = ["preinstall", "postinstall", "install"];

const FULL_CODEBASE_ANALYSIS = /(entire|whole|full)\s+(codebase|repository|source tree)/i;

function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hasInstallScriptHooks(root: string): boolean {
  const text = readTextSafe(join(root, "package.json"));
  if (text === undefined) return false;
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return false;
    return INSTALL_SCRIPT_HOOKS.some((hook) => Object.hasOwn(scripts, hook));
  } catch {
    // Malformed manifests are the trust scan's problem (trust.auto-exec-hook /
    // mcp.policy-denied fail closed there); the shape record stays structural.
    return false;
  }
}

function isInstallScriptFile(name: string): boolean {
  return isScriptLikeFilePath(name);
}

function fileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function hasInstallScripts(root: string): boolean {
  if (hasInstallScriptHooks(root)) return true;
  return [root, join(root, "scripts")].some((dir) => fileNames(dir).some(isInstallScriptFile));
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function rel(root: string, path: string): string {
  return toPosix(relative(root, path));
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function runtimeShapeRoots(root: string, skillDirs: readonly string[]): string[] {
  return [root, ...skillDirs];
}

function collectPackageManifestRels(root: string, skillDirs: readonly string[]): string[] {
  return uniqueValues(
    runtimeShapeRoots(root, skillDirs).flatMap((dir) =>
      PACKAGE_MANIFESTS.filter((name) => existsSync(join(dir, name))).map((name) =>
        rel(root, join(dir, name)),
      ),
    ),
  );
}

function collectInstallScriptFileRels(root: string, skillDirs: readonly string[]): string[] {
  return uniqueValues(
    runtimeShapeRoots(root, skillDirs).flatMap((dir) => {
      const packageJson = join(dir, "package.json");
      const hookFiles = hasInstallScriptHooks(dir) ? [rel(root, packageJson)] : [];
      const scriptFiles = [dir, join(dir, "scripts")].flatMap((scriptDir) =>
        fileNames(scriptDir)
          .filter(isInstallScriptFile)
          .map((name) => rel(root, join(scriptDir, name))),
      );
      return [...hookFiles, ...scriptFiles];
    }),
  );
}

function collectMcpConfigFileRels(root: string, skillDirs: readonly string[]): string[] {
  return uniqueValues(
    runtimeShapeRoots(root, skillDirs).flatMap((dir) =>
      [...INCOMING_MCP_CONFIG_FILES]
        .filter((name) => existsSync(join(dir, name)))
        .map((name) => rel(root, join(dir, name))),
    ),
  );
}

function mentionsFullCodebaseAnalysis(root: string, skillDirs: readonly string[]): boolean {
  const docs = [...skillDirs.map((dir) => join(dir, "SKILL.md")), join(root, "README.md")];
  return docs.some((path) => {
    const text = readTextSafe(path);
    return text !== undefined && FULL_CODEBASE_ANALYSIS.test(text);
  });
}

/** Compute the pure-fs skill shape of a trust source tree (no spawns, no writes). */
export function skillShape(root: string): SkillShape {
  const dirs = collectSkillDirs(root);
  const installScriptFiles = collectInstallScriptFileRels(root, dirs);
  const mcpConfigFiles = collectMcpConfigFileRels(root, dirs);
  const packageManifests = collectPackageManifestRels(root, dirs);
  return {
    skillDirs: dirs.map((dir) => promotedSkillRel(root, dir)),
    installScripts: installScriptFiles.length > 0 || hasInstallScripts(root),
    ...(installScriptFiles.length > 0 ? { installScriptFiles } : {}),
    mcpConfig: mcpConfigFiles.length > 0,
    ...(mcpConfigFiles.length > 0 ? { mcpConfigFiles } : {}),
    packageManifests,
    fullCodebaseAnalysis: mentionsFullCodebaseAnalysis(root, dirs),
  };
}
