import { describe, expect, it } from "vitest";
import {
  adapterNote,
  agentBehaviorCoreDoc,
  bootloaderPreamble,
  DISCIPLINE_INVARIANTS,
  DISCIPLINE_PRINCIPLES,
  disciplineBulletLines,
  disciplineSectionLines,
  invariantLines,
  reportingSectionLines,
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

/**
 * #507 slice A: the discipline text is authored ONCE (DISCIPLINE_PRINCIPLES /
 * DISCIPLINE_INVARIANTS / DISCIPLINE_REPORTING) and both documents render from
 * it — the shared block's compact bullets and the behavior core's long-form
 * sections. Same posture the secrets-invariants guard above established, extended
 * to every duplicated principle pair.
 */
describe("generated canon — single-source discipline (#507)", () => {
  /** The lines of `doc`'s `## <heading>` section, exclusive of the blank-line frame. */
  const section = (doc: string, heading: string): string[] => {
    const body = doc.split(`\n## ${heading}\n\n`)[1]?.split("\n\n## ")[0];
    expect(body, `section "## ${heading}" missing`).toBeDefined();
    return (body ?? "").split("\n");
  };

  it("the shared block's Working agreement renders every principle bullet from DISCIPLINE_PRINCIPLES, in order", () => {
    expect(DISCIPLINE_PRINCIPLES.map((p) => p.id)).toEqual([
      "think-before-coding",
      "simplicity-first",
      "surgical-changes",
      "goal-driven",
      "canon-tools",
    ]);
    expect(section(sharedCanonicalBlockBody(DIR), "Working agreement")).toEqual(
      disciplineBulletLines(),
    );
  });

  it("the behavior core renders each principle's long-form section from the same source, in document order", () => {
    const core = agentBehaviorCoreDoc(DIR);
    let cursor = -1;
    for (const p of DISCIPLINE_PRINCIPLES) {
      const rendered = disciplineSectionLines(p.id).join("\n");
      const at = core.indexOf(rendered);
      expect(
        at,
        `long-form section for "${p.id}" must render verbatim from the principle source`,
      ).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("shared-rendering invariants are byte-identical in both docs (graph-advisory joins the secrets guard)", () => {
    const block = sharedCanonicalBlockBody(DIR);
    const core = agentBehaviorCoreDoc(DIR);
    const shared = DISCIPLINE_INVARIANTS.filter((inv) => "shared" in inv);
    expect(shared.map((inv) => inv.id)).toEqual([
      "boundary-validation",
      "error-handling",
      "secrets",
      "public-surfaces",
      "graph-advisory",
    ]);
    for (const inv of shared) {
      for (const line of inv.shared) {
        expect(block).toContain(`\n${line}\n`);
        expect(core).toContain(`\n${line}\n`);
      }
    }
  });

  it("both invariant lists and the reporting pair derive from the single authored source", () => {
    const block = sharedCanonicalBlockBody(DIR);
    const core = agentBehaviorCoreDoc(DIR);
    expect(section(block, "Invariants")).toEqual(invariantLines("compact"));
    // The core appends its one core-only invariant (repo evidence over model
    // memory) after the shared-source list — assert the derived prefix exactly.
    const coreInvariants = section(core, "Invariants (always hold)");
    expect(coreInvariants.slice(0, invariantLines("longForm").length)).toEqual(
      invariantLines("longForm"),
    );
    expect(coreInvariants[invariantLines("longForm").length]).toMatch(/^- Repo evidence /);
    // Reporting: one authored pair, two renderings (compact summary vs itemized report).
    expect(block).toContain(reportingSectionLines("compact").join("\n"));
    expect(core).toContain(reportingSectionLines("longForm").join("\n"));
  });

  it("partitions invariant template text from per-repository stack facts", () => {
    const nodeStack: RepoStack = {
      ...emptyStack(),
      languages: ["TypeScript"],
      hasTypeScript: true,
      verifyCommand: "npm run verify",
      testRunner: "npm test",
    };
    const pythonStack: RepoStack = {
      ...emptyStack(),
      languages: ["Python"],
      verifyCommand: "pytest",
      testRunner: "pytest",
    };
    const node = ruleRouterDoc(DIR, "node-repo", nodeStack, ["AGENTS.md"], {
      canon: "compact",
    });
    const python = ruleRouterDoc(DIR, "python-repo", pythonStack, ["CLAUDE.md"], {
      canon: "compact",
    });

    expect(DISCIPLINE_INVARIANTS.every((invariant) => "shared" in invariant)).toBe(true);
    expect(invariantLines("compact")).toEqual(invariantLines("longForm"));
    expect(section(sharedCanonicalBlockBody(DIR), "Invariants")).toEqual(invariantLines("compact"));
    expect(section(node, "External action boundary")).toEqual(
      section(python, "External action boundary"),
    );
    expect(node).toContain("- Languages: TypeScript");
    expect(python).toContain("- Languages: Python");
  });
});

describe("generated canon — adapter delta (#507)", () => {
  it("keeps every compact adapter to the actual tool-specific delta", () => {
    for (const cli of SUPPORTED_CLIS) {
      const note = adapterNote(cli, DIR, "compact");
      expect(note.split("\n").filter(Boolean).length).toBeLessThanOrEqual(6);
      expect(note).toContain("- Entry:");
      expect(note).toContain("- Rule loading:");
      expect(note).toContain("- Baseline:");
      expect(note).toContain(`${DIR}/RULE_ROUTER.md`);
      expect(note).not.toContain("## Boundaries");
      expect(note).not.toContain("## Entry points");
    }
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
