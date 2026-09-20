/**
 * GitHub Skill intake, the pure half (acceptance rule section 7, row 18).
 *
 * A verbatim port of `parseSkillDiscovery` and `connectedSkillPin` from
 * `ui/artifact-intake-runtime.js`. Parsing is local and offline: it never
 * contacts GitHub and never runs the pasted command. The one connected step
 * (asking the local server to pin a commit) is a HOST capability; this module
 * only judges what the host brings back.
 */

import { COMMIT, exact, fail, ID, safePath } from "./artifact-intake-validation.js";

/** What one pasted Skill link or `npx skills add` command resolved to, locally. */
export interface SkillDiscoveryV1 {
  readonly repository: string;
  readonly skill: string;
  /** Empty until an exact permalink, or the connected resolver, pins one. */
  readonly commit: string;
  readonly path: string;
  readonly discoveryUrl: string;
  /** True when the paste itself carried the exact commit and SKILL.md path. */
  readonly exact: boolean;
}

/** Legacy `parseSkillDiscovery`. Throws with the runtime's exact message. */
export function parseSkillDiscoveryV1(raw: string): SkillDiscoveryV1 {
  if (typeof raw !== "string" || !raw || raw.length > 2048)
    fail("discovery input must contain 1-2048 characters");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this refuses, verbatim from the runtime
  if (/[\u0000-\u001f\u007f;&|$<>]/.test(raw) || raw.indexOf(String.fromCharCode(96)) !== -1)
    fail("command syntax is not accepted");
  let sourceValue = raw;
  let requestedSkill = "";
  const command = /^npx\s+skills\s+add\s+(\S+)\s+--skill\s+([a-z0-9][a-z0-9._-]{0,127})$/.exec(raw);
  if (command) {
    sourceValue = command[1] as string;
    requestedSkill = command[2] as string;
  } else if (/^npx\s/i.test(raw)) {
    fail("command syntax is not accepted");
  }
  const markdown = /^\[(https:\/\/[^\]\s]+)\]\((https:\/\/[^)\s]+)\)$/.exec(sourceValue);
  if (markdown) {
    if (markdown[1] !== markdown[2]) fail("Markdown link text and destination must match");
    sourceValue = markdown[2] as string;
  } else if (sourceValue.charAt(0) === "[" || sourceValue.indexOf("](") !== -1) {
    fail("Markdown link syntax is invalid");
  }
  let parsedUrl: URL;
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(sourceValue);
  if (shorthand) {
    parsedUrl = new URL(`https://github.com/${shorthand[1]}/${shorthand[2]}`);
  } else {
    try {
      parsedUrl = new URL(sourceValue);
    } catch {
      return fail("use a GitHub repository, skills.sh URL, or supported npx skills add command");
    }
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  )
    fail("discovery URL must be canonical HTTPS without credentials, query, or fragment");
  const host = parsedUrl.hostname.toLowerCase();
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  let owner = "";
  let repositoryName = "";
  let exactCommit = "";
  let exactPath = "";
  let discoveredSkill = "";
  if (host === "github.com" || host === "www.github.com") {
    if (segments.length < 2) fail("GitHub discovery URL must include owner/repository");
    owner = segments[0] as string;
    repositoryName = (segments[1] as string).replace(/\.git$/, "");
    if (segments.length > 2) {
      if (segments[2] !== "blob" || segments.length < 6 || !COMMIT.test(segments[3] as string))
        fail("GitHub file discovery must use a blob permalink with an exact 40-character commit");
      exactCommit = segments[3] as string;
      exactPath = segments.slice(4).join("/");
      safePath(exactPath, "Skill permalink path");
      if (!exactPath.endsWith("/SKILL.md")) fail("GitHub Skill permalink must end in SKILL.md");
      discoveredSkill = exactPath.split("/").slice(-2, -1)[0] || "";
    }
  } else if (host === "skills.sh" || host === "www.skills.sh") {
    if (segments.length < 2 || segments.length > 3)
      fail("skills.sh discovery URL must identify owner/repository and optionally one Skill");
    owner = segments[0] as string;
    repositoryName = segments[1] as string;
    discoveredSkill = segments[2] ?? "";
  } else {
    fail("Skill discovery supports only GitHub and skills.sh sources");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repositoryName))
    fail("Skill repository identity is invalid");
  const skill = requestedSkill || discoveredSkill;
  if (!ID.test(skill)) fail("include one valid --skill name or an exact Skill permalink");
  if (requestedSkill && discoveredSkill && requestedSkill !== discoveredSkill)
    fail("requested Skill does not match the permalink path");
  if (exactPath) safePath(exactPath, "Skill source path");
  return {
    repository: `${owner}/${repositoryName}`,
    skill,
    commit: exactCommit,
    path: exactPath,
    discoveryUrl: parsedUrl.href,
    exact: Boolean(exactCommit),
  };
}

/**
 * Legacy `connectedSkillPin`: what the local server brought back is untrusted
 * data, checked member by member against what was asked for.
 */
export function connectedSkillPinV1(
  value: unknown,
  parsed: SkillDiscoveryV1,
): { readonly commit: string; readonly path: string } {
  const invalid = "connected Skill resolver returned an invalid result";
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(invalid);
  const result = value as Record<string, unknown>;
  exact(
    result,
    ["version", "state", "skill", "source"],
    ["version", "state", "skill", "source"],
    "connected Skill result",
  );
  const source = result.source;
  if (
    result.version !== "aih-connected-github-skill/v1" ||
    result.state !== "resolved-not-scanned" ||
    result.skill !== parsed.skill ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source)
  )
    fail(invalid);
  const pin = source as Record<string, unknown>;
  exact(
    pin,
    ["type", "repository", "commit", "path"],
    ["type", "repository", "commit", "path"],
    "connected Skill source",
  );
  if (
    pin.type !== "github" ||
    pin.repository !== parsed.repository ||
    typeof pin.commit !== "string" ||
    !COMMIT.test(pin.commit) ||
    typeof pin.path !== "string"
  )
    fail(invalid);
  safePath(pin.path, "connected Skill source path");
  if (!pin.path.endsWith("/SKILL.md")) fail(invalid);
  return { commit: pin.commit, path: pin.path };
}
