import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skill = readFileSync(resolve("ai-coding/curated-skills/decision-partner/SKILL.md"), "utf8");
const gitignore = readFileSync(resolve(".gitignore"), "utf8");

describe("decision-partner truth routing", () => {
  it("rejects the retired decision ledgers and requires the current companion read set", () => {
    expect(skill).toContain("aih.privateCompanionRoot");
    expect(skill).toMatch(
      /Require its root `AGENTS\.md`, `README\.md`, `OPERATING-RULES\.md`, and `NEXT\.md`/,
    );
    expect(skill).not.toContain("decisions/OPEN-DECISIONS.md");
    expect(skill).not.toContain("decisions/DECISION-LOG.md");
    expect(skill).not.toContain(".internal/decision-sessions/");
    expect(skill).not.toContain("/.decision-sessions/");
    expect(skill).not.toMatch(/(?:^|[/`])DECISIONS\.md/);
  });

  it("keeps unresolved decisions in NEXT and settled decisions in affected current-truth feature files", () => {
    expect(skill).toMatch(/unresolved decisions?[^.]*`NEXT\.md`/i);
    expect(skill).toMatch(/settled decisions?[^.]*affected current-truth feature files/i);
  });

  it("cannot close a decision without the durable companion truth home", () => {
    expect(skill).toContain("Do not close or record a decision while the companion is unavailable");
    expect(skill).toContain("Publication authorization remains separate");
  });

  it("honors the unconditional manual self-hosting contract", () => {
    expect(skill).toContain("Never run AIH against this checkout.");
    expect(skill).toContain("ai-coding/SELF-HOSTING.md");
    expect(skill).not.toContain("routes through the generator");
    expect(skill).not.toMatch(/do not run aih commands that mutate this checkout/i);
  });

  it("does not hide an accidental local decision board", () => {
    expect(gitignore).not.toMatch(/^\/?\.decision-sessions\/?$/m);
  });
});
