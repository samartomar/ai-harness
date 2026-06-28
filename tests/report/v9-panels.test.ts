import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { driftDigest, mcpServersDigest, supportDigest } from "../../src/report/v9-panels.js";
import type { SupportTemplate } from "../../src/support/render.js";

const DIR = "ai-coding";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-v9panels-"));
  home = mkdtempSync(join(tmpdir(), "aih-v9panels-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: DIR,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: home, USERPROFILE: home },
    options: {},
  };
}

function put(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

interface DriftData {
  drifted: Array<{ file: string; delta: string }>;
  synced: string[];
  tracked: number;
}

describe("driftDigest", () => {
  it("returns undefined off-canon (no RULE_ROUTER.md)", () => {
    expect(driftDigest(ctx())).toBeUndefined();
  });

  it("reports an in-sync bootloader as synced", () => {
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put("CLAUDE.md", mergeManagedBlock(undefined, sharedBlock(DIR), "# Repo"));
    const d = driftDigest(ctx());
    expect(d).toBeDefined();
    const data = d?.data as DriftData;
    expect(data.synced).toContain("CLAUDE.md");
    expect(data.drifted).toHaveLength(0);
  });

  it("detects a drifted managed block (different body)", () => {
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put(
      "CLAUDE.md",
      mergeManagedBlock(undefined, { ...sharedBlock(DIR), body: "drifted body\n" }, "# Repo"),
    );
    const d = driftDigest(ctx());
    const data = d?.data as DriftData;
    expect(data.drifted).toHaveLength(1);
    expect(data.drifted[0]?.file).toBe("CLAUDE.md");
    expect(data.tracked).toBe(1);
  });
});

interface ServerData {
  servers: Array<[string, string]>;
  thirdParty: number;
}

describe("mcpServersDigest", () => {
  it("returns undefined when there is no .mcp.json", () => {
    expect(mcpServersDigest(ctx())).toBeUndefined();
  });

  it("maps configured servers to the catalog's egress class", () => {
    put(
      ".mcp.json",
      JSON.stringify({
        mcpServers: { "code-review-graph": { command: "uvx" }, "totally-unknown-xyz": {} },
      }),
    );
    const d = mcpServersDigest(ctx());
    const data = d?.data as ServerData;
    expect(data.servers).toContainEqual(["code-review-graph", "local"]);
    expect(data.servers).toContainEqual(["totally-unknown-xyz", "unknown"]);
  });

  it("flags third-party egress", () => {
    put(".mcp.json", JSON.stringify({ mcpServers: { context7: {} } }));
    const data = mcpServersDigest(ctx())?.data as ServerData;
    expect(data.servers).toContainEqual(["context7", "third-party"]);
    expect(data.thirdParty).toBe(1);
  });
});

/** A minimal SupportTemplate for the given kind (only the fields supportDigest reads). */
function tpl(kind: SupportTemplate["kind"], subject: string, body = "b"): SupportTemplate {
  return {
    id: `${kind}:x`,
    code: "report.low-adoption",
    kind,
    audience: "developer",
    severity: "optional",
    subject,
    body,
    copyLabel: "copy",
  } as unknown as SupportTemplate;
}

describe("supportDigest", () => {
  it("counts findings by who acts and surfaces the first escalation ticket", () => {
    const d = supportDigest([
      tpl("self-fix", "a"),
      tpl("self-fix", "b"),
      tpl("improvement", "c"),
      tpl("escalation", "MCP blocked", "add the corporate root CA"),
    ]);
    const data = d.data as {
      findings: { selfFix: number; improvement: number; escalation: number };
      ticket: string;
    };
    expect(data.findings).toEqual({ selfFix: 2, improvement: 1, escalation: 1 });
    expect(data.ticket).toContain("Subject: MCP blocked");
    expect(data.ticket).toContain("add the corporate root CA");
  });

  it("yields zero findings and an empty ticket for no templates", () => {
    const data = supportDigest([]).data as {
      findings: { selfFix: number; improvement: number; escalation: number };
      ticket: string;
    };
    expect(data.findings).toEqual({ selfFix: 0, improvement: 0, escalation: 0 });
    expect(data.ticket).toBe("");
  });
});
