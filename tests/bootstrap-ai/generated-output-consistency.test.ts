import { describe, expect, it } from "vitest";
import {
  adapterNote,
  agentBehaviorCoreDoc,
  bootloaderPreamble,
  ruleRouterDoc,
  sharedCanonicalBlockBody,
} from "../../src/bootstrap-ai/canon.js";
import type { ProjectContract } from "../../src/contract/schema.js";
import { setupDoc } from "../../src/contract/templates.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import type { RepoStack } from "../../src/profile/scan.js";
import { renderStackMdc } from "../../src/profile/templates.js";

/**
 * Cross-template consistency guards for the generated canon. Each test pins a
 * defect that shipped in real `aih init` output: a dangling section reference,
 * two invariant lists that drifted apart, a mangled empty-state sentence, a
 * hand-edit invitation inside a regenerated file, and a hardcoded reader list
 * that omitted a tool the docs themselves name as a reader.
 */

const DIR = ".ai-context";

function emptyStack(): RepoStack {
  return {
    languages: [],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    hasTypeScript: false,
    scripts: {},
    entryPoints: [],
    browserTest: false,
    isMonorepo: false,
  };
}

function contract(over: Partial<ProjectContract> = {}): ProjectContract {
  return {
    schemaVersion: 1,
    contextDir: DIR,
    targets: [],
    languages: [],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    entrypoints: [],
    mcpServers: [],
    commands: {},
    scale: { class: "small", isMonorepo: false },
    sensitivePaths: [],
    knownGaps: [],
    ...over,
  };
}

describe("generated canon — internal consistency", () => {
  it("compact router renders the External action boundary section every compact adapter cites", () => {
    const router = ruleRouterDoc(DIR, "repo", emptyStack(), ["CLAUDE.md"], { canon: "compact" });
    expect(router).toContain("## External action boundary");
    for (const cli of SUPPORTED_CLIS) {
      expect(adapterNote(cli, DIR, "compact")).toContain("§ External action boundary");
    }
  });

  it("shared block and behavior core carry byte-identical secrets invariants (drift guard)", () => {
    const pick = (doc: string) =>
      doc
        .split("\n")
        .filter((l) => l.startsWith("- No secrets") || l.startsWith("- Do not open `.env*`"));
    const block = pick(sharedCanonicalBlockBody(DIR));
    const core = pick(agentBehaviorCoreDoc(DIR));

    expect(block).toHaveLength(2);
    expect(core).toEqual(block);
    // The exception the enforcement layer already grants (.claudeignore keeps
    // the templates readable; aih itself generates .env.example).
    expect(block[1]).toContain("`.env.example` / `.env.sample` are readable templates");
  });

  it("AGENTS.md preamble derives its reader list from the registry (Kimi and Kiro included)", () => {
    const preamble = bootloaderPreamble("AGENTS.md", DIR, "repo", "compact");
    expect(preamble).toContain("Kimi CLI");
    expect(preamble).toContain("Kiro");
  });

  it("the empty-state Testing line routes through the generators, never a hand edit", () => {
    const compact = ruleRouterDoc(DIR, "repo", emptyStack(), ["CLAUDE.md"], { canon: "compact" });
    const legacy = ruleRouterDoc(DIR, "repo", emptyStack(), ["CLAUDE.md"], { canon: "legacy" });

    expect(compact).toContain("re-run `aih contract` and `aih bootstrap-ai` to record it");
    expect(legacy).toContain("re-run `aih bootstrap-ai` to record it");
    // Both routers are regenerated files — inviting a hand edit "here" was the bug.
    expect(compact).not.toContain("record it here");
    expect(legacy).not.toContain("record it here");
  });

  it("01-stack.mdc empty state is a well-formed sentence", () => {
    const mdc = renderStackMdc(emptyStack());
    expect(mdc).toContain("- No test/build/lint/format/start script is defined");
    expect(mdc).not.toContain("Use No test");
  });
});

describe("setup.md — fresh-clone executability", () => {
  it("names the pre-commit install step next to the hook it gates", () => {
    expect(setupDoc(DIR, contract())).toContain("Install `pre-commit`");
  });

  it("does not prescribe Node package managers when nothing was detected", () => {
    const doc = setupDoc(DIR, contract());
    expect(doc).toContain("No package manifest detected");
    expect(doc).not.toContain("npm / pnpm / yarn / bun");
  });

  it("names the right manager family for non-Node stacks", () => {
    expect(setupDoc(DIR, contract({ languages: ["Python"] }))).toContain("uv / poetry / pip");
    expect(setupDoc(DIR, contract({ languages: ["Go"] }))).toContain("go mod download");
  });

  it("still prefers a detected package manager over any fallback", () => {
    expect(setupDoc(DIR, contract({ packageManager: "pnpm" }))).toContain("`pnpm install`");
  });
});
