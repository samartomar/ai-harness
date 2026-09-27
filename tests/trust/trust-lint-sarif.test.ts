import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { trustLintChecksFromSarifV1 } from "../../src/trust/trust-lint-sarif.js";
import { PARITY_FIXTURES } from "./fakes/trust-parity-golden.js";

// ---------------------------------------------------------------------------
// Scan's detector.aih-trust-lint SARIF (recorded from Scan's own engine on the
// parity corpus) carries Core's native findings AND the per-file facts Core's
// third-party classification reads instead of running detection itself. Core
// validates every fact at the boundary and refuses the whole run on any doubt.
// ---------------------------------------------------------------------------

interface RecordedTrustLint {
  readonly request: {
    readonly selectedClosurePaths: string[];
    readonly detectorOptions: { internalScopes: string[]; mcpConfigPaths: string[] };
  };
  readonly sarif: { version: string; runs: Record<string, unknown>[] };
}

function recorded(id: string): RecordedTrustLint {
  return JSON.parse(
    readFileSync(join(PARITY_FIXTURES, "scan-trust-lint", `${id}.json`), "utf8"),
  ) as RecordedTrustLint;
}

function withRun(
  id: string,
  change: (run: Record<string, unknown>) => Record<string, unknown>,
): string {
  const { sarif } = recorded(id);
  const [run] = sarif.runs;
  if (run === undefined) throw new Error(`${id} has no run`);
  return JSON.stringify({ ...sarif, runs: [change(structuredClone(run))] });
}

function refusalOf(
  sarif: string,
  mcpConfigPaths: readonly string[] = [],
  selectedPaths: readonly string[] = [],
): string {
  const mapped = trustLintChecksFromSarifV1(sarif, "vibe", { selectedPaths, mcpConfigPaths });
  if (!("refusal" in mapped)) throw new Error("expected a refusal");
  return mapped.refusal;
}

describe("trust-lint SARIF facts", () => {
  it("reads the run facts and every sealed file's facts", () => {
    const entry = recorded("legal-text");
    const mapped = trustLintChecksFromSarifV1(JSON.stringify(entry.sarif), "vibe", {
      selectedPaths: entry.request.selectedClosurePaths,
    });
    if ("refusal" in mapped) throw new Error(mapped.refusal);
    expect(mapped.checks).toEqual([]);
    expect(mapped.facts.trustDocumentCount).toBe(1);
    expect(mapped.facts.repositoryLicenseFile).toBe("LICENSE");
    expect([...mapped.facts.artifacts.keys()]).toEqual(["LICENSE", "SKILL.md"]);
    expect(mapped.facts.artifacts.get("LICENSE")).toEqual({
      unreadable: false,
      strictUnicodeSurface: false,
      legalText: true,
      unicodeRisk: null,
      lintLines: new Map([[4, ["trust.prompt-injection"]]]),
      yr4CorepackIntegrityOnly: false,
    });
  });

  it("tags an MCP description finding with the declared server it came from", () => {
    const entry = recorded("mcp-configs");
    const mapped = trustLintChecksFromSarifV1(JSON.stringify(entry.sarif), "vibe", {
      selectedPaths: entry.request.selectedClosurePaths,
      mcpConfigPaths: entry.request.detectorOptions.mcpConfigPaths,
    });
    if ("refusal" in mapped) throw new Error(mapped.refusal);
    expect(mapped.checks.map((entry) => entry.mcpDescription)).toEqual([
      { configPath: ".mcp.json", mapKey: "mcpServers", server: "local-notes" },
    ]);
    expect(mapped.checks[0]?.check.location?.uri).toBe(
      ".mcp.json#mcpServers.local-notes.description",
    );
  });

  it("refuses a description finding for a config Core did not declare", () => {
    expect(refusalOf(JSON.stringify(recorded("mcp-configs").sarif))).toContain(
      "undeclared MCP server description",
    );
  });

  it("refuses a description pseudo path that carries no description property", () => {
    const sarif = withRun("mcp-configs", (run) => ({
      ...run,
      results: (run.results as Record<string, unknown>[]).map(
        ({ properties: _drop, ...result }) => result,
      ),
    }));
    expect(refusalOf(sarif, [".mcp.json"])).toContain("has no source-relative location");
  });

  it.each([
    ["no facts", (run: Record<string, unknown>) => ({ ...run, properties: {} })],
    [
      "a malformed trust document count",
      (run: Record<string, unknown>) => ({
        ...run,
        properties: {
          "aih-trust/v1": { format: "aih-trust-lint-facts", version: 1, trustDocumentCount: -1 },
        },
      }),
    ],
    [
      "a duplicate artifact",
      (run: Record<string, unknown>) => ({
        ...run,
        artifacts: [...(run.artifacts as unknown[]), (run.artifacts as unknown[])[0]],
      }),
    ],
    [
      "an artifact outside the source root",
      (run: Record<string, unknown>) => ({
        ...run,
        artifacts: [{ location: { uri: "../LICENSE" }, properties: {} }],
      }),
    ],
    [
      "an unreadable artifact that still carries facts",
      (run: Record<string, unknown>) => ({
        ...run,
        artifacts: [
          {
            location: { uri: "LICENSE" },
            properties: { "aih-trust/v1": { unreadable: true, legalText: true } },
          },
        ],
      }),
    ],
    [
      "a lint line naming a code the fact cannot carry",
      (run: Record<string, unknown>) => ({
        ...run,
        artifacts: [
          {
            location: { uri: "LICENSE" },
            properties: {
              "aih-trust/v1": {
                strictUnicodeSurface: false,
                legalText: true,
                unicodeRisk: null,
                lintLines: [{ line: 4, codes: ["trust.malicious-code"] }],
              },
            },
          },
        ],
      }),
    ],
  ])("refuses a run with %s", (_label, change) => {
    expect(refusalOf(withRun("legal-text", change))).toMatch(/^detector\.aih-trust-lint /);
  });

  it.each([
    [
      "no artifact list",
      (run: Record<string, unknown>) => {
        const { artifacts: _drop, ...rest } = run;
        return rest;
      },
    ],
    ["a null artifact list", (run: Record<string, unknown>) => ({ ...run, artifacts: null })],
  ])("refuses a run with %s rather than reading its facts as absent", (_label, change) => {
    const { request } = recorded("legal-text");
    expect(refusalOf(withRun("legal-text", change), [], request.selectedClosurePaths)).toContain(
      "detector.aih-trust-lint run carries no artifact facts list",
    );
  });

  it("refuses artifact facts that do not cover every selected file", () => {
    const { request } = recorded("prompt-injection");
    const sarif = withRun("prompt-injection", (run) => ({
      ...run,
      artifacts: (run.artifacts as { location: { uri: string } }[]).filter(
        (artifact) => artifact.location.uri !== "SKILL.md",
      ),
    }));
    expect(refusalOf(sarif, [], request.selectedClosurePaths)).toContain(
      "detector.aih-trust-lint states no facts for selected file SKILL.md",
    );
  });

  it("refuses more than one run", () => {
    const { sarif } = recorded("legal-text");
    expect(refusalOf(JSON.stringify({ ...sarif, runs: [...sarif.runs, ...sarif.runs] }))).toContain(
      "exactly one run",
    );
  });
});
