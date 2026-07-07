import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("deferred analytics tiers design note", () => {
  it("scopes Tier 2 as aggregate-first and preserves the D2 no-remote-call invariant", () => {
    const note = read("docs/research/deferred-analytics-tiers.md");

    expect(note).toContain("Tier 2 is an **operator-owned shared collector**");
    expect(note).toContain("aggregate-first");
    expect(note).toContain("D2 is preserved");
    expect(note).toContain("`aih report` reads local JSON/artifacts only");
    expect(note).toContain("does not schedule cron, run the fetcher, or call the Admin API");
    expect(note).toContain(
      "Raw prompts, tool I/O, secrets, command args, and source file contents",
    );
  });

  it("captures Tier 3 hosted-SaaS trigger conditions without changing shipped command behavior", () => {
    const note = read("docs/research/deferred-analytics-tiers.md");

    expect(note).toContain("Tier 3 is a **hosted analytics SaaS** decision");
    expect(note).toContain("Tier 2's aggregate schema has stabilized");
    expect(note).toContain("privacy review approves the exact collected fields");
    expect(note).toContain("no default remote endpoint");
    expect(note.replace(/\s+/g, " ")).toContain(
      "no background upload from `aih report`, `aih usage`, or `aih telemetry`",
    );
  });

  it("links the deferred decision from the shipped analytics plan and docs index", () => {
    expect(read("docs/analytics-report-plan.md")).toContain("research/deferred-analytics-tiers.md");
    expect(read("docs/README.md")).toContain("research/deferred-analytics-tiers.md");
  });
});
