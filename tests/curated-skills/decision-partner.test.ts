import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skill = readFileSync(resolve("ai-coding/curated-skills/decision-partner/SKILL.md"), "utf8");
const gitignore = readFileSync(resolve(".gitignore"), "utf8");

describe("decision-partner truth routing", () => {
  it("uses the companion's declared decision homes instead of a second ledger", () => {
    expect(skill).toContain("aih.privateCompanionRoot");
    expect(skill).toContain("decisions/OPEN-DECISIONS.md");
    expect(skill).toContain("decisions/DECISION-LOG.md");
    expect(skill).not.toContain(".internal/decision-sessions/");
    expect(skill).not.toContain("/.decision-sessions/");
    expect(skill).not.toMatch(/(?:^|[/`])DECISIONS\.md/);
  });

  it("cannot close a decision without the durable companion truth home", () => {
    expect(skill).toContain("Do not close or record a decision while the companion is unavailable");
    expect(skill).toContain("Publication authorization remains separate");
  });

  it("does not hide an accidental local decision board", () => {
    expect(gitignore).not.toMatch(/^\/?\.decision-sessions\/?$/m);
  });
});
