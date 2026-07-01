import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/prune/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-prune-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

function write(rel: string, content = "x"): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function previewText(over: Partial<PlanContext> = {}): string {
  const p = command.plan(ctx(over)) as { actions: { kind: string; text?: string }[] };
  const d = p.actions.find((a) => a.kind === "digest");
  return d?.text ?? "";
}

describe("aih prune preview", () => {
  it("guides the user when there is no committed target set to diff", () => {
    const text = previewText();
    expect(text).toContain("No committed target set");
    expect(text).toContain("aih bootstrap-ai");
  });

  it("uses a mechanism-accurate note per block kind (no 'managed block' for JSON MCP)", () => {
    writeFileSync(
      join(dir, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
    );
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md"); // dropped — bootloader AGENTS.md (text marker block)
    write("ai-coding/adapters/cursor.md"); // dropped — MCP JSON (json key merge)
    write("AGENTS.md");
    write(".cursor/rules/00-canon.mdc");
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
    const text = previewText();
    // Bootloader keeps the marker-block wording; MCP uses JSON-merge wording.
    expect(text).toContain("managed block subtracted"); // AGENTS.md / .cursor bootloader
    expect(text).toContain("aih's server entries removed"); // .cursor/mcp.json
    // The old one-size-fits-all "managed block; hand-edits preserved" is gone for MCP.
    expect(text).not.toContain("managed block; hand-edits preserved");
  });
});
