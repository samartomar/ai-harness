import { basename, isAbsolute, join, relative } from "node:path";
import { parseDocument } from "yaml";
import { readRegularFile } from "../internals/fsxn.js";
import type { Check } from "../internals/verify.js";

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

export interface LicenseCheckOptions {
  skillRoot?: string;
}

function readTextSafe(path: string): string | undefined {
  return readRegularFile(path)?.toString("utf8");
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function sourceRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path).replace(/\\/g, "/");
  if (rel.length === 0 || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function evidencePath(root: string, evidenceRoot: string, fileName: string): string {
  const full = join(evidenceRoot, fileName);
  return sourceRelative(root, full) ?? basename(full);
}

function containedSkillRoot(root: string, skillRoot: string | undefined): string | undefined {
  if (skillRoot === undefined) return undefined;
  if (relative(root, skillRoot) === "") return skillRoot;
  return sourceRelative(root, skillRoot) === undefined ? undefined : skillRoot;
}

function packageJsonLicense(root: string): string | undefined {
  const text = readTextSafe(join(root, "package.json"));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { license?: unknown };
    return typeof parsed.license === "string" && parsed.license.trim().length > 0
      ? parsed.license.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function skillFrontmatterLicense(root: string): string | undefined {
  const text = readTextSafe(join(root, "SKILL.md"));
  if (text === undefined || !text.startsWith("---")) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match?.[1] === undefined) return undefined;
  try {
    const raw = parseDocument(match[1]).get("license");
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

function detectedLicense(root: string, evidenceRoot: string): Check | undefined {
  const frontmatter = skillFrontmatterLicense(evidenceRoot);
  if (frontmatter !== undefined) {
    return {
      name: "skill license",
      verdict: "pass",
      detail: `${evidencePath(root, evidenceRoot, "SKILL.md")} license: ${frontmatter}`,
    };
  }
  for (const name of LICENSE_FILES) {
    const text = readTextSafe(join(evidenceRoot, name));
    if (text === undefined) continue;
    const detected = firstLine(text)?.slice(0, 120) ?? name;
    return {
      name: "skill license",
      verdict: "pass",
      detail: `${evidencePath(root, evidenceRoot, name)}: ${detected}`,
    };
  }
  const declared = packageJsonLicense(evidenceRoot);
  if (declared !== undefined) {
    return {
      name: "skill license",
      verdict: "pass",
      detail: `${evidencePath(root, evidenceRoot, "package.json")} license: ${declared}`,
    };
  }
  return undefined;
}

/**
 * License presence gate for an external skill source. Found → pass with the
 * detected name (explicit SKILL.md frontmatter, first line of the license file,
 * or the package.json value — deliberately NOT an SPDX parser). Absent → fail
 * `trust.license-missing`, which the verdict engine grades UNKNOWN (evidence
 * insufficient, not proven danger).
 */
export function licenseCheck(root: string, options: LicenseCheckOptions = {}): Check {
  const skillRoot = containedSkillRoot(root, options.skillRoot);
  if (options.skillRoot !== undefined && skillRoot === undefined) {
    return {
      name: "skill license",
      verdict: "fail",
      code: "trust.license-missing",
      detail: "selected skill root is outside the source root; no license evidence accepted",
    };
  }
  if (skillRoot !== undefined) {
    const skillLicense = detectedLicense(root, skillRoot);
    if (skillLicense !== undefined) return skillLicense;
  }
  const checkedSkillRoot = skillRoot !== undefined;
  const rootLicense = detectedLicense(root, root);
  if (rootLicense !== undefined) return rootLicense;

  return {
    name: "skill license",
    verdict: "fail",
    code: "trust.license-missing",
    detail: checkedSkillRoot
      ? "no LICENSE/LICENSE.md/LICENSE.txt/COPYING file, SKILL.md license frontmatter, or package.json license field at the selected skill root or source root"
      : "no LICENSE/LICENSE.md/LICENSE.txt/COPYING file or package.json license field at the source root",
  };
}
