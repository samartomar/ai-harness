import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const guidesDir = join(root, "guides");

interface SurfaceArgument {
  name: string;
  required: boolean;
}

interface SurfaceOption {
  flags: string;
  defaultValue?: string | boolean;
}

interface SurfaceCommand {
  name: string;
  aliases?: string[];
  hasDescription: boolean;
  arguments: SurfaceArgument[];
  options: SurfaceOption[];
  commands: SurfaceCommand[];
}

interface GuideFile {
  rel: string;
  abs: string;
  text: string;
}

interface LocatedText {
  rel: string;
  line: number;
  text: string;
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function guideFiles(): GuideFile[] {
  return readdirSync(guidesDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const rel = `guides/${name}`;
      const abs = join(root, rel);
      return { rel, abs, text: read(rel) };
    });
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function localMarkdownLinks(file: GuideFile): LocatedText[] {
  const out: LocatedText[] = [];
  const lines = file.text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1] ?? "";
      const target =
        rawTarget
          .trim()
          .replace(/^<(.+)>$/u, "$1")
          .split(/\s+/u)[0] ?? "";
      if (target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
        continue;
      }
      const localPath = target.split("#")[0] ?? "";
      if (localPath === "") continue;
      out.push({ rel: file.rel, line: index + 1, text: localPath });
    }
  });
  return out;
}

function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/gu, "").replace(/`[^`\n]*`/gu, "");
}

function fencedBlocks(file: GuideFile): LocatedText[] {
  const out: LocatedText[] = [];
  const lines = file.text.split(/\r?\n/u);
  let inFence = false;
  let startLine = 0;
  let body: string[] = [];
  lines.forEach((line, index) => {
    if (/^\s*```/u.test(line)) {
      if (inFence) {
        out.push({ rel: file.rel, line: startLine, text: body.join("\n") });
        body = [];
        inFence = false;
      } else {
        inFence = true;
        startLine = index + 1;
      }
      return;
    }
    if (inFence) body.push(line);
  });
  return out;
}

function commandSurface(): Map<string, SurfaceCommand> {
  const rootCommand = JSON.parse(read("tests/contract/command-surface.json")) as SurfaceCommand;
  const commands = new Map<string, SurfaceCommand>();
  for (const command of rootCommand.commands) {
    commands.set(command.name, command);
    for (const alias of command.aliases ?? []) commands.set(alias, command);
  }
  return commands;
}

function inlineCodeSpans(file: GuideFile): LocatedText[] {
  const out: LocatedText[] = [];
  const lines = file.text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/`([^`\n]*\baih\s+[^`\n]*)`/gu)) {
      out.push({ rel: file.rel, line: index + 1, text: match[1] ?? "" });
    }
  });
  return out;
}

function fencedAihLines(file: GuideFile): LocatedText[] {
  const out: LocatedText[] = [];
  const lines = file.text.split(/\r?\n/u);
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;
    const command = line.trim().replace(/^(?:PS>|[$>])\s*/u, "");
    if (command.startsWith("aih ")) {
      out.push({ rel: file.rel, line: index + 1, text: command });
    }
  });
  return out;
}

function commandExamples(files: GuideFile[]): LocatedText[] {
  return files.flatMap((file) => [...inlineCodeSpans(file), ...fencedAihLines(file)]);
}

function commandErrors(examples: LocatedText[], commands: Map<string, SurfaceCommand>): string[] {
  const errors: string[] = [];
  for (const example of examples) {
    for (const match of example.text.matchAll(/\baih\s+([^\s`|,;)]+)/gu)) {
      const firstToken = match[1] ?? "";
      if (firstToken.startsWith("<")) continue;
      const command = commands.get(firstToken);
      if (command === undefined) {
        errors.push(`${example.rel}:${example.line}: unknown aih command in \`${example.text}\``);
        continue;
      }

      const rest = example.text.slice((match.index ?? 0) + match[0].length).trim();
      const nextToken = /^([^\s`|,;)]+)/u.exec(rest)?.[1];
      if (nextToken !== undefined && /^[A-Za-z0-9-]+\/[A-Za-z0-9-]+/u.test(nextToken)) {
        errors.push(
          `${example.rel}:${example.line}: shorthand command token in \`${example.text}\``,
        );
        continue;
      }

      const nextCommand =
        nextToken !== undefined ? /^([A-Za-z0-9-]+)/u.exec(nextToken)?.[1] : undefined;
      if (
        nextCommand !== undefined &&
        command.arguments.length === 0 &&
        command.options.length === 0 &&
        command.commands.length > 0 &&
        !command.commands.some((subcommand) => subcommand.name === nextCommand)
      ) {
        errors.push(
          `${example.rel}:${example.line}: unknown aih subcommand in \`${example.text}\``,
        );
      }
    }
  }
  return errors;
}

describe("public guide surface", () => {
  it("keeps guide-local Markdown links resolvable", () => {
    const errors: LocatedText[] = [];
    for (const file of guideFiles()) {
      for (const link of localMarkdownLinks(file)) {
        const abs = resolve(dirname(file.abs), link.text);
        if (!isContained(root, abs) || !existsSync(abs)) {
          errors.push({ rel: link.rel, line: link.line, text: link.text });
        }
      }
    }

    expect(errors.map((link) => `${link.rel}:${link.line}: ${link.text}`)).toEqual([]);
  });

  it("keeps the guide index linked to every guide", () => {
    const index = read("guides/README.md");
    const linked = new Set(
      [...index.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/gu)].map((match) => match[1] ?? ""),
    );
    const expected = guideFiles()
      .map((file) => file.rel.replace(/^guides\//u, ""))
      .filter((name) => name !== "README.md")
      .sort();

    expect(
      [...linked].filter((name) => name.endsWith(".md") && !name.startsWith("../")).sort(),
    ).toEqual(expected);
  });

  it("keeps guide aih command examples aligned with the committed command surface", () => {
    const errors = commandErrors(commandExamples(guideFiles()), commandSurface());

    expect(errors).toEqual([]);
  });

  it("keeps enterprise guides focused on approved enterprise examples", () => {
    const enterpriseFiles = guideFiles().filter((file) => file.rel.includes("enterprise-"));
    const findings = enterpriseFiles.flatMap((file) =>
      [...file.text.matchAll(/\b(?:Supabase|superbase)\b/giu)].map(
        (match) => `${file.rel}: unexpected enterprise example: ${match[0]}`,
      ),
    );

    expect(findings).toEqual([]);
  });

  it("keeps public guides free of private paths and literal secret values", () => {
    const patterns: Array<[string, RegExp]> = [
      ["internal repo path", /\bai-harness-internal\b/giu],
      ["Windows user path", /\b[A-Z]:\\Users\\/gu],
      ["local harness path", /\b[A-Z]:\\dev\\harness\\/gu],
      ["POSIX user path", /\/Users\/[A-Za-z0-9._-]+/gu],
      ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/gu],
      ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu],
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/gu],
      [
        "literal secret assignment",
        /\b(?:GITHUB_PERSONAL_ACCESS_TOKEN|JIRA_API_TOKEN|FIGMA_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\b\s*[:=]\s*["']?(?!\$\{|<)[A-Za-z0-9_./+=-]{12,}/gu,
      ],
      ["literal bearer token", /\bAuthorization\s*:\s*Bearer\s+(?!\$\{|<)[A-Za-z0-9._-]{20,}/giu],
    ];
    const findings = guideFiles().flatMap((file) =>
      patterns.flatMap(([name, pattern]) =>
        [...file.text.matchAll(pattern)].map((match) => `${file.rel}: ${name}: ${match[0]}`),
      ),
    );

    expect(findings).toEqual([]);
  });

  it("does not publish floating package versions in copy-paste fenced examples", () => {
    const findings = guideFiles().flatMap((file) =>
      fencedBlocks(file).flatMap((block) =>
        [...block.text.matchAll(/@latest\b/gu)].map(
          () => `${block.rel}:${block.line}: fenced example contains @latest`,
        ),
      ),
    );

    expect(findings).toEqual([]);
  });

  it("keeps unsupported assurance wording out of public guide prose", () => {
    const unsupportedAssurance =
      /\b(?:enterprise-grade|production-ready|production-proven|battle-tested|SOC 2-ready|HIPAA-compliant|SLSA-compliant|secure by default|zero[- ]risk|fully audited|certified|guaranteed)\b/giu;
    const findings = guideFiles().flatMap((file) =>
      [...stripCode(file.text).matchAll(unsupportedAssurance)].map(
        (match) => `${file.rel}: unsupported assurance wording: ${match[0]}`,
      ),
    );

    expect(findings).toEqual([]);
  });
});
