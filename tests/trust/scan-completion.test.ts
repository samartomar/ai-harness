import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkedScanSarifLogV1,
  type ExpectedScanCompletionV1,
  SCAN_COMPLETION_PROPERTY_V1,
  scanCompletionRefusalV1,
} from "../../src/trust/scan-sarif.js";
import {
  namedScanSubjectFilesV1,
  scanDetectorSubjectFilesV1,
  scanSubjectDigestV1,
  sealedScanSubjectFilesV1,
} from "../../src/trust/scan-subject-files.js";

// ---------------------------------------------------------------------------
// Owner principle: an analyzer result counts as completed with zero findings
// only when its own output proves the subject was analyzed. Core checks the
// shape of that proof (C2a §1.4) and recomputes the subject it names (C2a §1.6).
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "aih-scan-completion-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }
  return root;
}

const DRIVER = { driver: { name: "fixture-analyzer" } };

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tool: DRIVER, invocations: [{ executionSuccessful: true }], results: [], ...overrides };
}

function refusal(log: unknown): string | undefined {
  const checked = checkedScanSarifLogV1(log);
  return "refusal" in checked ? checked.refusal : undefined;
}

describe("the completion predicate every SARIF log from Scan must meet", () => {
  it("accepts a completed run with no findings and a warning notification", () => {
    expect(
      refusal({
        version: "2.1.0",
        runs: [
          run({
            invocations: [
              {
                executionSuccessful: true,
                toolExecutionNotifications: [{ level: "warning", message: { text: "skipped" } }],
              },
            ],
          }),
        ],
      }),
    ).toBeUndefined();
  });

  it.each([
    ["no runs", { version: "2.1.0", runs: [] }, "a SARIF log with no runs"],
    [
      "no tool driver",
      { version: "2.1.0", runs: [run({ tool: undefined })] },
      "SARIF whose run 0 names no tool driver",
    ],
    [
      "an empty driver name",
      { version: "2.1.0", runs: [run({ tool: { driver: { name: "" } } })] },
      "SARIF whose run 0 names no tool driver",
    ],
    [
      "no invocations",
      { version: "2.1.0", runs: [run({ invocations: undefined })] },
      "SARIF whose run 0 reports no invocation, so nothing proves the analyzer completed",
    ],
    [
      "an empty invocation list",
      { version: "2.1.0", runs: [run({ invocations: [] })] },
      "SARIF whose run 0 reports no invocation, so nothing proves the analyzer completed",
    ],
    [
      "an unsuccessful second invocation",
      {
        version: "2.1.0",
        runs: [
          run({ invocations: [{ executionSuccessful: true }, { executionSuccessful: false }] }),
        ],
      },
      "SARIF whose run 0 invocation 1 is not executionSuccessful: true",
    ],
    [
      "a truthy but not true executionSuccessful",
      { version: "2.1.0", runs: [run({ invocations: [{ executionSuccessful: "true" }] })] },
      "SARIF whose run 0 invocation 0 is not executionSuccessful: true",
    ],
    [
      "a notification list that is not a list",
      {
        version: "2.1.0",
        runs: [
          run({
            invocations: [{ executionSuccessful: true, toolConfigurationNotifications: {} }],
          }),
        ],
      },
      "SARIF whose run 0 invocation 0 has malformed toolConfigurationNotifications",
    ],
    [
      "an unknown notification level",
      {
        version: "2.1.0",
        runs: [
          run({
            invocations: [
              { executionSuccessful: true, toolExecutionNotifications: [{ level: "fatal" }] },
            ],
          }),
        ],
      },
      "SARIF whose run 0 invocation 0 has malformed toolExecutionNotifications",
    ],
    [
      "a notification message that is not a message object",
      {
        version: "2.1.0",
        runs: [
          run({
            invocations: [
              {
                executionSuccessful: true,
                toolExecutionNotifications: [{ level: "note", message: { markdown: "x" } }],
              },
            ],
          }),
        ],
      },
      "SARIF whose run 0 invocation 0 has malformed toolExecutionNotifications",
    ],
    [
      "an error-level notification",
      {
        version: "2.1.0",
        runs: [
          run({
            invocations: [
              {
                executionSuccessful: true,
                toolExecutionNotifications: [{ level: "error", message: { text: "crashed" } }],
              },
            ],
          }),
        ],
      },
      "SARIF whose run 0 invocation 0 reports an error-level notification in toolExecutionNotifications",
    ],
    [
      "a malformed notification beside an error-level one (malformed first)",
      {
        version: "2.1.0",
        runs: [
          run({
            invocations: [
              {
                executionSuccessful: true,
                toolExecutionNotifications: [{ level: "error" }],
                toolConfigurationNotifications: ["not an object"],
              },
            ],
          }),
        ],
      },
      "SARIF whose run 0 invocation 0 has malformed toolConfigurationNotifications",
    ],
  ])("refuses %s", (_name, log, reason) => {
    expect(refusal(log)).toBe(reason);
  });
});

describe("subject-files-v1, Core's recomputation of the subject Scan names", () => {
  it("matches the contract's test vector and the empty set", () => {
    const root = tree({ "SKILL.md": "# alpha\n", "scripts/run.sh": "echo\n" });
    const files = sealedScanSubjectFilesV1(root);
    expect(files).toEqual([
      {
        path: "SKILL.md",
        sha256: "a6098732ccd311fb1f4cf46a2e05389ac24f7207f9be513a0d1d423d8109b2c7",
      },
      {
        path: "scripts/run.sh",
        sha256: "86b0c5a1e2b73b08fd54c727f4458649ed9fe3ad1b6e8ac9460c070113509a1e",
      },
    ]);
    expect(scanSubjectDigestV1(files)).toEqual({
      subjectTreeSha256: "adc6c170f014a8d238d3f18b3cd44e82cbfbe1f7fa9b4bafae6f5aab1cece047",
      analyzedFileCount: 2,
    });
    expect(scanSubjectDigestV1([])).toEqual({
      subjectTreeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      analyzedFileCount: 0,
    });
  });

  it("keys a file link by its path over its target's bytes and skips a directory link", () => {
    const root = tree({ "docs/guide.md": "guide\n", "SKILL.md": "# alpha\n" });
    symlinkSync(join(root, "docs", "guide.md"), join(root, "linked.md"), "file");
    symlinkSync(
      join(root, "docs"),
      join(root, "docs-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const files = sealedScanSubjectFilesV1(root);
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "docs/guide.md", "linked.md"]);
    expect(files[2]?.sha256).toBe(files[1]?.sha256);
  });

  it("refuses a link that leaves the source root", () => {
    const root = tree({ "SKILL.md": "# alpha\n" });
    const outside = tree({ "secret.md": "outside\n" });
    symlinkSync(join(outside, "secret.md"), join(root, "escape.md"), "file");
    expect(() => sealedScanSubjectFilesV1(root)).toThrow(
      "symbolic link escape.md leaves the source root",
    );
  });

  it("applies each detector's subject rule", () => {
    const root = tree({
      ".git/HEAD": "ref\n",
      "SKILL.md": "# root\n",
      "skills/beta/SKILL.md": "# beta\n",
      "skills/beta/run.sh": "echo\n",
      "notes/readme.md": "notes\n",
      "nested/.git/config": "x\n",
      ".mcp.json": "{}\n",
    });
    const sealed = () => sealedScanSubjectFilesV1(root);
    const paths = (detectorId: string, selected: string[], mcp?: string[]) =>
      scanDetectorSubjectFilesV1(detectorId, root, {
        selectedClosurePaths: selected,
        ...(mcp === undefined ? {} : { mcpConfigPaths: mcp }),
        sealed,
      }).map((file) => file.path);
    const all = sealed().map((file) => file.path);
    expect(paths("detector.semgrep", [])).toEqual(all);
    expect(paths("detector.skillspector", [])).toEqual(all);
    // Only the top-level .git leaves the snapshot.
    expect(paths("detector.snyk-agent-scan", [])).toEqual(
      all.filter((path) => !path.startsWith(".git/")),
    );
    expect(paths("detector.snyk-agent-scan", [])).toContain("nested/.git/config");
    // Cisco: the files under each selected SKILL.md directory, the root job being all of them.
    expect(paths("detector.cisco", ["skills/beta/SKILL.md", "notes/readme.md"])).toEqual([
      "skills/beta/SKILL.md",
      "skills/beta/run.sh",
    ]);
    expect(paths("detector.cisco", ["SKILL.md"])).toEqual(
      all.filter((path) => !path.startsWith(".git/")),
    );
    expect(paths("detector.cisco-mcp-scanner", [], [".mcp.json"])).toEqual([".mcp.json"]);
    expect(paths("detector.aih-trust-lint", ["SKILL.md", "notes/readme.md"])).toEqual([
      "SKILL.md",
      "notes/readme.md",
    ]);
    expect(() => paths("detector.aih-binding-gate", ["missing.md"])).toThrow(
      "selected path missing.md is not in the source tree",
    );
    expect(() => paths("detector.aih-trust-lint", ["skills/beta"])).toThrow(
      "selected path skills/beta is not a file",
    );
    expect(() => paths("detector.unknown", [])).toThrow("Core has no subject rule");
  });

  it("does not follow a named path through a directory link the seal does not enter", () => {
    const root = tree({ "docs/guide.md": "guide\n" });
    symlinkSync(
      join(root, "docs"),
      join(root, "docs-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      namedScanSubjectFilesV1(root, ["docs-link/guide.md"], { required: true, label: "path" }),
    ).toThrow("path docs-link/guide.md is not in the source tree");
    expect(
      namedScanSubjectFilesV1(root, ["docs-link"], { required: false, label: "path" }),
    ).toEqual([]);
  });
});

describe("completion evidence v1 binds a run to the subject Core submitted", () => {
  const subject = {
    subjectTreeSha256: "adc6c170f014a8d238d3f18b3cd44e82cbfbe1f7fa9b4bafae6f5aab1cece047",
    analyzedFileCount: 2,
  };
  const expected: ExpectedScanCompletionV1 = {
    detectorId: "detector.semgrep",
    subject,
    emptyAllowed: true,
    analyzer: {
      version: "1.173.0+uvlock.77f2bf3e7525",
      lockSha256: "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
    },
  };
  const evidence = (overrides: Record<string, unknown> = {}) => ({
    detectorId: expected.detectorId,
    ...subject,
    analyzer: { ...expected.analyzer },
    ...overrides,
  });
  const logWith = (...evidences: unknown[]) => {
    const checked = checkedScanSarifLogV1({
      version: "2.1.0",
      runs: evidences.map((stated) =>
        run({
          invocations: [
            {
              executionSuccessful: true,
              properties: {
                kept: "analyzer property",
                ...(stated === undefined ? {} : { [SCAN_COMPLETION_PROPERTY_V1]: stated }),
              },
            },
          ],
        }),
      ),
    });
    if ("refusal" in checked) throw new Error(checked.refusal);
    return checked.log;
  };

  it("accepts evidence equal in every run and naming exactly what Core expects", () => {
    expect(scanCompletionRefusalV1(logWith(evidence(), evidence()), expected)).toBeUndefined();
  });

  it.each([
    [
      "no evidence",
      [undefined],
      "SARIF whose run 0 carries no aihScanCompletionV1 completion evidence",
    ],
    [
      "an extra key",
      [evidence({ note: "extra" })],
      "SARIF whose run 0 carries malformed aihScanCompletionV1 completion evidence",
    ],
    [
      "an extra analyzer key",
      [evidence({ analyzer: { ...expected.analyzer, image: "x" } })],
      "SARIF whose run 0 carries malformed aihScanCompletionV1 completion evidence",
    ],
    [
      "an uppercase digest",
      [evidence({ subjectTreeSha256: subject.subjectTreeSha256.toUpperCase() })],
      "SARIF whose run 0 carries malformed aihScanCompletionV1 completion evidence",
    ],
    [
      "a fractional count",
      [evidence({ analyzedFileCount: 1.5 })],
      "SARIF whose run 0 carries malformed aihScanCompletionV1 completion evidence",
    ],
    [
      "runs that disagree",
      [evidence(), evidence({ analyzedFileCount: 3 })],
      "SARIF whose runs carry different aihScanCompletionV1 completion evidence",
    ],
    [
      "another detector",
      [evidence({ detectorId: "detector.cisco" })],
      'completion evidence for "detector.cisco", not the requested detector.semgrep',
    ],
    [
      "another subject",
      [evidence({ subjectTreeSha256: "0".repeat(64) })],
      `completion evidence for 2 files with subject tree ${"0".repeat(64)}; the subject Core submitted has 2 files with subject tree ${subject.subjectTreeSha256}`,
    ],
    [
      "another analyzer lock",
      [evidence({ analyzer: { version: expected.analyzer.version, lockSha256: null } })],
      `completion evidence for analyzer "1.173.0+uvlock.77f2bf3e7525" with no uv.lock; Core accepts 1.173.0+uvlock.77f2bf3e7525 with uv.lock ${expected.analyzer.lockSha256}`,
    ],
  ])("refuses %s", (_name, evidences, reason) => {
    expect(scanCompletionRefusalV1(logWith(...evidences), expected)).toBe(reason);
  });

  it("allows zero analyzed files only for a detector that completes on an empty source", () => {
    const empty = {
      subjectTreeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      analyzedFileCount: 0,
    };
    const log = logWith(evidence(empty));
    expect(scanCompletionRefusalV1(log, { ...expected, subject: empty })).toBeUndefined();
    expect(scanCompletionRefusalV1(log, { ...expected, subject: empty, emptyAllowed: false })).toBe(
      "completion evidence of zero analyzed files, and detector.semgrep does not complete on an empty source",
    );
  });
});
