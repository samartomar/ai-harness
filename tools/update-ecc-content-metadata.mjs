import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined) throw new Error(`missing --${name}`);
  return process.argv[index + 1];
}

const repositoryPath = resolve(option("repo"));
const commit = option("commit");
const output = resolve(option("output"));
const repository = option("repository");

function git(...args) {
  const result = spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function frontmatter(markdown, path) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) throw new Error(`${path} has no YAML frontmatter`);
  const parsed = parse(match[1]);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} frontmatter is not a mapping`);
  }
  return { parsed, body: markdown.slice(match[0].length) };
}

function summaryFrom(parsed, body, path) {
  if (typeof parsed.description === "string" && parsed.description.trim() !== "") {
    return parsed.description.replace(/\s+/g, " ").trim();
  }
  const withoutDefense = body.replace(/## Prompt Defense Baseline[\s\S]*?(?=\r?\n## |$)/, "");
  const purpose = withoutDefense.match(/(?:^|\r?\n)#{1,2} (?:Purpose|Overview)\r?\n+([\s\S]*?)(?=\r?\n#{1,2} |$)/i);
  const paragraphs = (purpose?.[1] ?? withoutDefense)
    .split(/\r?\n\s*\r?\n/)
    .map((value) => value.replace(/^[-*>#\s]+/, "").replace(/\s+/g, " ").trim())
    .filter((value) => value !== "" && !value.startsWith("```"));
  if (paragraphs[0] === undefined) throw new Error(`${path} has no usable summary`);
  return paragraphs[0];
}

function plainMarkdown(value) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function usageContextFrom(parsed, body, summary) {
  for (const key of ["usage", "usage_context", "when_to_use", "trigger", "triggers"]) {
    if (typeof parsed[key] === "string" && parsed[key].trim() !== "") {
      return plainMarkdown(parsed[key]);
    }
  }
  const withoutDefense = body.replace(/## Prompt Defense Baseline[\s\S]*?(?=\r?\n## |$)/, "");
  const section = withoutDefense.match(
    /(?:^|\r?\n)#{1,3}\s+(?:When to Use|Use When|Usage(?: Context)?|Triggers?|Invocation|When Invoked)[^\r\n]*\r?\n+([\s\S]*?)(?=\r?\n#{1,3}\s|$)/i,
  );
  if (section?.[1]) {
    const value = plainMarkdown(section[1]);
    if (value !== "") return value.slice(0, 1_500);
  }
  const usageSentences = summary
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => /\b(?:use|invoke|run|trigger|proactive|after|before|when)\b/i.test(sentence));
  return (usageSentences.length > 0 ? usageSentences.join(" ") : summary).slice(0, 1_500);
}

function toolsFrom(value, path) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (values === null || values.some((item) => typeof item !== "string")) {
    throw new Error(`${path} tools must be a string or string array`);
  }
  return values.map((item) => item.trim()).filter(Boolean);
}

function entry(path, expectedName) {
  const markdown = git("show", `${commit}:${path}`);
  const { parsed, body } = frontmatter(markdown, path);
  const name = typeof parsed.name === "string" ? parsed.name.trim() : expectedName;
  const summary = summaryFrom(parsed, body, path);
  return {
    id: expectedName,
    ...(name === expectedName ? {} : { declaredName: name }),
    title: typeof parsed.title === "string" && parsed.title.trim() !== "" ? parsed.title.trim() : name,
    path,
    summary,
    usageContext: usageContextFrom(parsed, body, summary),
    allowedTools: toolsFrom(parsed.tools, path),
    sourceSha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
  };
}

git("cat-file", "-e", `${commit}^{commit}`);
const paths = git("ls-tree", "-r", "--name-only", commit, "--", "agents", "skills")
  .split(/\r?\n/)
  .filter(Boolean);
const agents = paths
  .filter((path) => /^agents\/[a-z0-9][a-z0-9-]*\.md$/.test(path))
  .map((path) => entry(path, path.slice("agents/".length, -".md".length)))
  .sort((left, right) => left.id.localeCompare(right.id));
const skills = paths
  .filter((path) => /^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(path))
  .map((path) => entry(path, path.split("/")[1]))
  .sort((left, right) => left.id.localeCompare(right.id));

writeFileSync(
  output,
  `${JSON.stringify({ version: 1, repository, commit, agents, skills }, null, 2)}\n`,
  "utf8",
);
console.log(`wrote ${agents.length} agents and ${skills.length} skills to ${output}`);
