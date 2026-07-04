import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { Check } from "../internals/verify.js";

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
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

/**
 * License presence gate for an external skill source. Found → pass with the
 * detected name (explicit SKILL.md frontmatter, first line of the license file,
 * or the package.json value — deliberately NOT an SPDX parser). Absent → fail
 * `trust.license-missing`, which the verdict engine grades UNKNOWN (evidence
 * insufficient, not proven danger).
 */
export function licenseCheck(root: string): Check {
  const frontmatter = skillFrontmatterLicense(root);
  if (frontmatter !== undefined) {
    return { name: "skill license", verdict: "pass", detail: `SKILL.md license: ${frontmatter}` };
  }
  for (const name of LICENSE_FILES) {
    const text = readTextSafe(join(root, name));
    if (text === undefined) continue;
    const detected = firstLine(text)?.slice(0, 120) ?? name;
    return { name: "skill license", verdict: "pass", detail: `${name}: ${detected}` };
  }
  const declared = packageJsonLicense(root);
  if (declared !== undefined) {
    return { name: "skill license", verdict: "pass", detail: `package.json license: ${declared}` };
  }
  return {
    name: "skill license",
    verdict: "fail",
    code: "trust.license-missing",
    detail:
      "no LICENSE/LICENSE.md/LICENSE.txt/COPYING file or package.json license field at the source root",
  };
}
