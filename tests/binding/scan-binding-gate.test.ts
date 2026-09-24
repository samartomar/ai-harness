import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BINDING_GATE_DETECTOR_ID,
  BINDING_GATE_DIMENSIONS,
  BINDING_GATE_EXECUTION_PROFILE,
  BindingGateScanError,
  inspectTreeThroughScanV1,
} from "../../src/binding/scan-binding-gate.js";
import {
  type DimensionReport,
  inspectTree,
  runFastScanGate,
  type ScannableSource,
} from "../../src/binding/scan-gate.js";
import { ScanPackageRefusalError } from "../../src/scan-package/load-scan-package.js";
import { TrustScanCancelledError } from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";
import {
  createSelfCompletingFakeScanAdapterForTests,
  createVerbatimFakeScanAdapterForTests,
  FAKE_SCAN_PROFILES,
  type FakeScanAdapterForTests,
} from "../trust/fakes/fake-scan-adapter.js";
import { bindingGateSarifForTests, fakeBindingGateScan } from "./fake-binding-gate.js";

// With no injected adapter, Core loads the installed @aihq/scan; here that load
// fails exactly as a missing package does, so the refusal path is observable.
vi.mock("../../src/scan-package/load-scan-package.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/scan-package/load-scan-package.js")>();
  return {
    ...original,
    loadScanExecutionAdapterV1: () =>
      original.loadScanExecutionAdapterV1(() =>
        Promise.reject(
          Object.assign(new Error("Cannot find package '@aihq/scan' imported from core"), {
            code: "ERR_MODULE_NOT_FOUND",
          }),
        ),
      ),
  };
});

const SHA_A = "a".repeat(64);

let tree: string;
let cacheHome: string;

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "aih-binding-gate-tree-"));
  cacheHome = mkdtempSync(join(tmpdir(), "aih-binding-gate-cache-"));
  writeTree(tree, { "SKILL.md": "# skill\n", "src/a.ts": "export const a = 1;\n" });
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
  rmSync(cacheHome, { recursive: true, force: true });
});

const SELECTED = ["SKILL.md", "src/a.ts"] as const;

function sha256Lf(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** The pin Core computes for a file of the tree: its CRLF-normalized text sha256. */
function contentPin(path: string): string {
  return existsSync(join(tree, path)) ? sha256Lf(readFileSync(join(tree, path), "utf8")) : SHA_A;
}

function pinned(code: string, path: string, contentSha256 = contentPin(path)) {
  return {
    code,
    severity: code === "trust.visible-unicode" ? ("medium" as const) : ("high" as const),
    detail: `${code} in ${path}`,
    coverage: "complete" as const,
    path,
    contentSha256,
  };
}

/** A fake Scan answering Core's request with SARIF edited by `edit`. */
function editedSarifScan(
  reports: readonly DimensionReport[],
  edit: (log: { runs: [Record<string, unknown> & { results: Record<string, unknown>[] }] }) => void,
): FakeScanAdapterForTests {
  return createSelfCompletingFakeScanAdapterForTests({
    [BINDING_GATE_DETECTOR_ID]: {
      kind: "sarif-for",
      sarif: () => {
        const log = JSON.parse(bindingGateSarifForTests(reports));
        edit(log);
        return JSON.stringify(log);
      },
    },
  });
}

function factsOf(result: Record<string, unknown>): Record<string, unknown> {
  return (
    (result.properties as Record<string, Record<string, unknown>>)["aih-binding-gate/v1"] ?? {}
  );
}

function dimensionsOf(log: { runs: [Record<string, unknown>] }): Record<string, unknown>[] {
  const properties = log.runs[0].properties as Record<string, { dimensions: [] }>;
  return properties["aih-binding-gate/v1"]?.dimensions ?? [];
}

async function refusalOf(scan: FakeScanAdapterForTests): Promise<unknown> {
  return inspectTreeThroughScanV1(tree, [...SELECTED], { scanExecution: scan }).catch(
    (error: unknown) => error,
  );
}

describe("the request Core sends to detector.aih-binding-gate", () => {
  it("names the detector and profile, sends a source-tree subject at the realpath with Core's inventory, and no options", async () => {
    // .git is outside the digest's fileset; node_modules is inside it (CM-27/D7).
    writeTree(tree, { ".git/config": "[core]\n", "node_modules/dep/index.js": "x;\n" });
    const scan = fakeBindingGateScan();
    const controller = new AbortController();

    await inspectTree(tree, { scanExecution: scan, signal: controller.signal });

    expect(scan.requests).toHaveLength(1);
    const request = scan.requests[0] ?? {};
    const inventory = buildTrustFileInventory(tree, { skipDirs: new Set([".git"]) });
    expect(Object.keys(request).sort()).toEqual(
      ["detectorId", "executionProfileId", "signal", "subject"].sort(),
    );
    expect(request.detectorId).toBe(BINDING_GATE_DETECTOR_ID);
    expect(request.executionProfileId).toBe(BINDING_GATE_EXECUTION_PROFILE);
    expect(request.subject).toEqual({
      kind: "source-tree",
      sourceRoot: realpathSync(tree),
      selectedClosurePaths: inventory.files.map((entry) => entry.relativePath),
    });
    const selected = (request.subject as { selectedClosurePaths: string[] }).selectedClosurePaths;
    expect(selected).toContain("node_modules/dep/index.js");
    expect(selected.some((path) => path.startsWith(".git/"))).toBe(false);
    expect(request).not.toHaveProperty("detectorOptions");
    expect(request.signal).toBe(controller.signal);
  });

  it("sends no signal key when the caller has none", async () => {
    const scan = fakeBindingGateScan();
    await inspectTreeThroughScanV1(tree, [...SELECTED], { scanExecution: scan });
    expect(scan.requests[0]).not.toHaveProperty("signal");
  });
});

describe("Scan's binding-gate SARIF as Core's dimension reports", () => {
  it("round-trips every dimension in Scan's order with its findings, pins and per-file facts", async () => {
    const reports: DimensionReport[] = [
      {
        dimension: "scripts",
        status: "produced",
        findings: [
          {
            code: "trust.install-script",
            severity: "medium",
            detail: "install script",
            coverage: "complete",
          },
        ],
      },
      { dimension: "licenses", status: "missing", reason: "no license detector", findings: [] },
      {
        dimension: "hidden-unicode",
        status: "produced",
        findings: [
          pinned("trust.hidden-unicode", "SKILL.md"),
          pinned("trust.visible-unicode", "src/a.ts"),
        ],
        typography: { "SKILL.md": { demote: true, contextClass: "prose" } },
        dottedIBlocking: { "src/a.ts": true },
      },
    ];

    const inspected = await inspectTreeThroughScanV1(tree, [...SELECTED], {
      scanExecution: fakeBindingGateScan(reports),
    });

    expect(inspected.map((report) => report.dimension)).toEqual([...BINDING_GATE_DIMENSIONS]);
    const byName = new Map(inspected.map((report) => [report.dimension, report]));
    expect(byName.get("scripts")).toEqual(reports[0]);
    expect(byName.get("licenses")).toEqual(reports[1]);
    // Scan's extra typography detail (occurrence count) is not Core's to keep.
    expect(byName.get("hidden-unicode")).toEqual(reports[2]);
    for (const name of BINDING_GATE_DIMENSIONS.filter(
      (dimension) => !["scripts", "licenses", "hidden-unicode"].includes(dimension),
    )) {
      expect(byName.get(name)).toEqual({ dimension: name, status: "produced", findings: [] });
    }
  });

  it("keeps a typography verdict without a context class as Scan stated it", async () => {
    const inspected = await inspectTreeThroughScanV1(tree, [...SELECTED], {
      scanExecution: fakeBindingGateScan([
        {
          dimension: "hidden-unicode",
          status: "produced",
          findings: [pinned("trust.hidden-unicode", "SKILL.md")],
          typography: { "SKILL.md": { demote: false } },
        },
      ]),
    });
    expect(inspected.find((report) => report.dimension === "hidden-unicode")?.typography).toEqual({
      "SKILL.md": { demote: false },
    });
  });
});

describe("refusals: the gate never decides on an inspection Core cannot account for", () => {
  it("refuses with scan-package-unavailable when @aihq/scan is not installed", async () => {
    const refusal = await inspectTreeThroughScanV1(tree, [...SELECTED]).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ScanPackageRefusalError);
    expect((refusal as ScanPackageRefusalError).refusal.reason).toBe("scan-package-unavailable");
    expect((refusal as Error).message).toContain("npm install");
  });

  it("refuses with scan-package-incompatible when Scan has no binding-gate detector", async () => {
    const scan = createSelfCompletingFakeScanAdapterForTests({
      "detector.aih-trust-lint": { kind: "sarif", sarif: "{}" },
    });
    const refusal = await refusalOf(scan);
    expect(refusal).toBeInstanceOf(ScanPackageRefusalError);
    expect((refusal as ScanPackageRefusalError).refusal.reason).toBe("scan-package-incompatible");
    expect(scan.requests).toHaveLength(0);
  });

  it("refuses with scan-package-incompatible when the capability lacks the binding-gate profile", async () => {
    const scan = createSelfCompletingFakeScanAdapterForTests(
      {
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "sarif-for",
          sarif: () => bindingGateSarifForTests([]),
        },
      },
      {
        profiles: {
          [BINDING_GATE_DETECTOR_ID]: FAKE_SCAN_PROFILES["detector.aih-trust-lint"] ?? [],
        },
      },
    );
    const refusal = await refusalOf(scan);
    expect(refusal).toBeInstanceOf(ScanPackageRefusalError);
    expect((refusal as ScanPackageRefusalError).refusal.reason).toBe("scan-package-incompatible");
    expect((refusal as Error).message).toContain(BINDING_GATE_EXECUTION_PROFILE);
    expect(scan.requests).toHaveLength(0);
  });

  it("refuses with scan-package-incompatible when the profile does not support this host", async () => {
    const scan = createSelfCompletingFakeScanAdapterForTests(
      {
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "sarif-for",
          sarif: () => bindingGateSarifForTests([]),
        },
      },
      {
        profiles: {
          [BINDING_GATE_DETECTOR_ID]: [
            {
              id: BINDING_GATE_EXECUTION_PROFILE,
              isolation: "none",
              network: "none",
              supportedPlatforms: [{ os: "plan9", architecture: "mips" }],
            },
          ],
        },
      },
    );
    const refusal = await refusalOf(scan);
    expect(refusal).toBeInstanceOf(ScanPackageRefusalError);
    expect((refusal as ScanPackageRefusalError).refusal.reason).toBe("scan-package-incompatible");
  });

  it("carries Scan's words when Scan refuses the run", async () => {
    const refusal = await refusalOf(
      createSelfCompletingFakeScanAdapterForTests({
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "refused",
          reason: "subject-unreadable",
          detail: "the source root vanished",
        },
      }),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("refused");
    expect((refusal as Error).message).toContain("subject-unreadable: the source root vanished");
  });

  it("carries Scan's words when the run fails", async () => {
    const refusal = await refusalOf(
      createSelfCompletingFakeScanAdapterForTests({
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "failed",
          stage: "execution",
          detail: "inventory file disappeared",
        },
      }),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("failed");
    expect((refusal as Error).message).toContain("execution: inventory file disappeared");
  });

  it("wraps an adapter that throws as a BindingGateScanError", async () => {
    const scan = fakeBindingGateScan();
    const throwing: FakeScanAdapterForTests = {
      ...scan,
      runDetectorV1: async () => {
        throw new Error("adapter exploded");
      },
    };
    const refusal = await refusalOf(throwing);
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("adapter exploded");
  });

  it("refuses a run Scan reports under a different execution profile", async () => {
    const refusal = await refusalOf(
      createSelfCompletingFakeScanAdapterForTests({
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "sarif",
          sarif: bindingGateSarifForTests([]),
          executionProfileId: "in-process-other-v1",
        },
      }),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("in-process-other-v1");
  });

  it("refuses a binding gate whose capability declares a version Core does not accept, running nothing", async () => {
    const scan = createSelfCompletingFakeScanAdapterForTests({
      [BINDING_GATE_DETECTOR_ID]: { kind: "sarif", sarif: bindingGateSarifForTests([]) },
    });
    const [capability] = scan.listDetectorCapabilitiesV1() as Record<string, unknown>[];
    if (capability === undefined) throw new Error("fake lost the binding gate");
    capability.analyzerVersion = "9.9.9";
    const refusal = await refusalOf(scan);
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain(
      "detector.aih-binding-gate under in-process-binding-gate-v1 declares analyzer 9.9.9 with no uv.lock; Core accepts 1.0.0 with no uv.lock",
    );
    expect(scan.requests).toEqual([]);
  });

  it("refuses a binding-gate run whose observation names another analyzer version", async () => {
    const refusal = await refusalOf(
      createSelfCompletingFakeScanAdapterForTests({
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "sarif",
          sarif: bindingGateSarifForTests([]),
          observedAnalyzerVersion: "1.0.1",
        },
      }),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain(
      "ran analyzer 1.0.1 with no uv.lock; Core accepts 1.0.0 with no uv.lock",
    );
  });

  it("refuses SARIF that is not a single-run 2.1.0 log with binding-gate facts", async () => {
    // Verbatim bytes: nothing is added or repaired. Runs that must reach the
    // binding-gate structure check carry completion evidence for the selection,
    // its subject computed by hand (sha256 over "SKILL.md\0<sha256>\n" and
    // "src/a.ts\0<sha256>\n" of "# skill\n" and "export const a = 1;\n").
    const selection = {
      detectorId: BINDING_GATE_DETECTOR_ID,
      subjectTreeSha256: "587431b388d7697ca47c3dc63d151068bedc77259de78b4ee3f63ab7f61b729b",
      analyzedFileCount: 2,
      analyzer: { version: "1.0.0", lockSha256: null },
    };
    const factsRun = {
      ...JSON.parse(bindingGateSarifForTests([])).runs[0],
      invocations: [{ executionSuccessful: true, properties: { aihScanCompletionV1: selection } }],
    };
    const { properties: _facts, ...bareRun } = factsRun;
    for (const [sarif, message] of [
      ["not json", "detector.aih-binding-gate returned bytes that are not JSON"],
      [
        JSON.stringify({ version: "2.1.0", runs: [] }),
        "detector.aih-binding-gate returned a SARIF log with no runs",
      ],
      [
        JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }),
        "detector.aih-binding-gate returned SARIF whose run 0 names no tool driver",
      ],
      [
        JSON.stringify({ version: "2.1.0", runs: [factsRun, factsRun] }),
        "detector.aih-binding-gate must return a SARIF 2.1.0 log with exactly one run",
      ],
      [
        JSON.stringify({ version: "2.1.0", runs: [bareRun] }),
        "detector.aih-binding-gate run carries no aih-binding-gate-report facts",
      ],
    ] as const) {
      const refusal = await refusalOf(
        createVerbatimFakeScanAdapterForTests({
          [BINDING_GATE_DETECTOR_ID]: { kind: "sarif", sarif },
        }),
      );
      expect(refusal).toBeInstanceOf(BindingGateScanError);
      expect((refusal as Error).message).toBe(message);
    }
  });

  it("refuses a missing dimension", async () => {
    const refusal = await refusalOf(
      editedSarifScan([], (log) => {
        dimensionsOf(log).splice(3, 1);
      }),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("must report exactly the dimensions");
  });

  it("refuses reordered dimensions", async () => {
    const refusal = await refusalOf(
      editedSarifScan([], (log) => {
        dimensionsOf(log).reverse();
      }),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("must report exactly the dimensions");
  });

  it("refuses results out of dimension order", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [
          { dimension: "scripts", status: "produced", findings: [pinned("trust.a", "SKILL.md")] },
          { dimension: "mcp", status: "produced", findings: [pinned("trust.b", "SKILL.md")] },
        ],
        (log) => {
          log.runs[0].results.reverse();
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("out of dimension order");
  });

  it("refuses a dimension whose finding count disagrees with its results", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [{ dimension: "hooks", status: "produced", findings: [pinned("trust.hook", "SKILL.md")] }],
        (log) => {
          const hooks = dimensionsOf(log).find((dimension) => dimension.name === "hooks");
          if (hooks !== undefined) hooks.findingCount = 2;
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain(
      "dimension hooks reports 2 findings but carries 1",
    );
  });

  it("refuses a missing dimension without a reason", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [{ dimension: "mcp", status: "missing", reason: "x", findings: [] }],
        (log) => {
          const mcp = dimensionsOf(log).find((dimension) => dimension.name === "mcp");
          if (mcp !== undefined) mcp.reason = undefined;
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("missing dimension mcp must state a reason");
  });

  it("refuses an inspection whose SARIF does not prove the selection was analyzed", async () => {
    // Unmodified responses: the verbatim fake adds nothing to these bytes.
    const withoutEvidence = await refusalOf(
      createVerbatimFakeScanAdapterForTests({
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "sarif",
          sarif: JSON.stringify({
            ...JSON.parse(bindingGateSarifForTests([])),
            runs: JSON.parse(bindingGateSarifForTests([])).runs.map(
              (run: Record<string, unknown>) => ({
                ...run,
                invocations: [{ executionSuccessful: true }],
              }),
            ),
          }),
        },
      }),
    );
    expect(withoutEvidence).toBeInstanceOf(BindingGateScanError);
    expect((withoutEvidence as Error).message).toBe(
      "detector.aih-binding-gate returned SARIF whose run 0 carries no aihScanCompletionV1 completion evidence",
    );
    // Evidence for an empty selection (the contract's empty-set vector), not the one Core sent.
    const emptySelection = {
      detectorId: BINDING_GATE_DETECTOR_ID,
      subjectTreeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      analyzedFileCount: 0,
      analyzer: { version: "1.0.0", lockSha256: null },
    };
    const otherSelection = await refusalOf(
      createVerbatimFakeScanAdapterForTests({
        [BINDING_GATE_DETECTOR_ID]: {
          kind: "sarif",
          sarif: JSON.stringify({
            ...JSON.parse(bindingGateSarifForTests([])),
            runs: JSON.parse(bindingGateSarifForTests([])).runs.map(
              (run: Record<string, unknown>) => ({
                ...run,
                tool: { driver: { name: "aih-binding-gate" } },
                invocations: [
                  {
                    executionSuccessful: true,
                    properties: { aihScanCompletionV1: emptySelection },
                  },
                ],
              }),
            ),
          }),
        },
      }),
    );
    expect(otherSelection).toBeInstanceOf(BindingGateScanError);
    expect((otherSelection as Error).message).toContain("completion evidence for 0 files");
  });

  it("refuses a pin on a path Core did not send", async () => {
    const refusal = await refusalOf(
      fakeBindingGateScan([
        {
          dimension: "hidden-unicode",
          status: "produced",
          findings: [pinned("trust.hidden-unicode", "not-sent.md")],
        },
      ]),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("pins a path Core did not send");
  });

  it("refuses a pin without a content sha256", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [
          {
            dimension: "hidden-unicode",
            status: "produced",
            findings: [pinned("trust.hidden-unicode", "SKILL.md")],
          },
        ],
        (log) => {
          const [result] = log.runs[0].results;
          if (result !== undefined) factsOf(result).contentSha256 = "not-a-hash";
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("without a content sha256");
  });

  it("refuses a pin whose content sha256 is not the selected file's normalized content", async () => {
    const refusal = await refusalOf(
      fakeBindingGateScan([
        {
          dimension: "hidden-unicode",
          status: "produced",
          findings: [pinned("trust.hidden-unicode", "SKILL.md", SHA_A)],
        },
      ]),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain(
      `result 0 pins SKILL.md at ${SHA_A}, but Core computed ${sha256Lf("# skill\n")}`,
    );
  });

  it("accepts a pin over the CRLF-normalized text, which is what Core computes", async () => {
    writeTree(tree, { "SKILL.md": "# skill\r\nline\r\n" });
    const normalized = sha256Lf("# skill\nline\n");
    const inspected = await inspectTreeThroughScanV1(tree, [...SELECTED], {
      scanExecution: fakeBindingGateScan([
        {
          dimension: "hidden-unicode",
          status: "produced",
          findings: [pinned("trust.hidden-unicode", "SKILL.md", normalized)],
        },
      ]),
    });
    expect(
      inspected.find((report) => report.dimension === "hidden-unicode")?.findings[0]?.contentSha256,
    ).toBe(normalized);
  });

  it("refuses a typography verdict on a code other than trust.hidden-unicode", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [
          {
            dimension: "hidden-unicode",
            status: "produced",
            findings: [pinned("trust.visible-unicode", "SKILL.md")],
          },
        ],
        (log) => {
          const [result] = log.runs[0].results;
          if (result !== undefined) factsOf(result).typography = { demote: true };
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("typography verdict Core cannot place");
  });

  it("refuses a dotted-I fact on a code other than trust.visible-unicode", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [
          {
            dimension: "hidden-unicode",
            status: "produced",
            findings: [pinned("trust.hidden-unicode", "SKILL.md")],
          },
        ],
        (log) => {
          const [result] = log.runs[0].results;
          if (result !== undefined) factsOf(result).dottedIBlocking = true;
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("dotted-I fact Core cannot place");
  });

  it("refuses two typography verdicts that disagree for one file", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [
          {
            dimension: "hidden-unicode",
            status: "produced",
            findings: [
              pinned("trust.hidden-unicode", "SKILL.md"),
              { ...pinned("trust.hidden-unicode", "SKILL.md"), detail: "second occurrence" },
            ],
            typography: { "SKILL.md": { demote: true } },
          },
        ],
        (log) => {
          const second = log.runs[0].results[1];
          if (second !== undefined) factsOf(second).typography = { demote: false };
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("two typography verdicts disagree for SKILL.md");
  });

  it("refuses two dotted-I facts that disagree for one file", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [
          {
            dimension: "hidden-unicode",
            status: "produced",
            findings: [
              pinned("trust.visible-unicode", "src/a.ts"),
              { ...pinned("trust.visible-unicode", "src/a.ts"), detail: "second occurrence" },
            ],
            dottedIBlocking: { "src/a.ts": false },
          },
        ],
        (log) => {
          const second = log.runs[0].results[1];
          if (second !== undefined) factsOf(second).dottedIBlocking = true;
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("two dotted-I facts disagree for src/a.ts");
  });

  it("refuses a result that is not a binding-gate finding", async () => {
    const refusal = await refusalOf(
      editedSarifScan(
        [{ dimension: "mcp", status: "produced", findings: [pinned("trust.mcp", "SKILL.md")] }],
        (log) => {
          const [result] = log.runs[0].results;
          if (result !== undefined) factsOf(result).severity = "catastrophic";
        },
      ),
    );
    expect(refusal).toBeInstanceOf(BindingGateScanError);
    expect((refusal as Error).message).toContain("result 0 is not a binding-gate finding");
  });
});

describe("cancellation", () => {
  it("throws TrustScanCancelledError and never starts Scan when the signal is already aborted", async () => {
    const scan = fakeBindingGateScan();
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectTreeThroughScanV1(tree, [...SELECTED], {
        scanExecution: scan,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TrustScanCancelledError);
    expect(scan.requests).toHaveLength(0);
  });

  it("throws TrustScanCancelledError when the run is cancelled while Scan is running", async () => {
    const scan = createSelfCompletingFakeScanAdapterForTests({
      [BINDING_GATE_DETECTOR_ID]: { kind: "block-until-aborted" },
    });
    const controller = new AbortController();
    const running = inspectTreeThroughScanV1(tree, [...SELECTED], {
      scanExecution: scan,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(scan.requests).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(TrustScanCancelledError);
    expect(scan.aborted).toEqual([BINDING_GATE_DETECTOR_ID]);
  });
});

describe("runFastScanGate caches nothing from an inspection that did not complete", () => {
  function source(): ScannableSource {
    return { digest: "d".repeat(64), treePath: tree, identityFiles: [...SELECTED] };
  }

  it("writes no cache record when Scan refuses, and asks Scan again next time", async () => {
    const refused = createSelfCompletingFakeScanAdapterForTests({
      [BINDING_GATE_DETECTOR_ID]: { kind: "refused", reason: "busy", detail: "try again" },
    });
    await expect(
      runFastScanGate(source(), { posture: "enterprise" }, { cacheHome, scanExecution: refused }),
    ).rejects.toBeInstanceOf(BindingGateScanError);
    expect(existsSync(join(cacheHome, "scan-cache"))).toBe(false);

    const scan = fakeBindingGateScan();
    const disposition = await runFastScanGate(
      source(),
      { posture: "enterprise" },
      { cacheHome, scanExecution: scan },
    );
    expect(scan.requests).toHaveLength(1);
    expect(disposition.verdict).toBe("allow");
    expect(existsSync(join(cacheHome, "scan-cache", `${"d".repeat(64)}.json`))).toBe(true);
  });

  it("writes no cache record for SARIF Core cannot account for", async () => {
    const bad = editedSarifScan([], (log) => {
      dimensionsOf(log).pop();
    });
    await expect(
      runFastScanGate(source(), { posture: "enterprise" }, { cacheHome, scanExecution: bad }),
    ).rejects.toBeInstanceOf(BindingGateScanError);
    expect(existsSync(join(cacheHome, "scan-cache"))).toBe(false);
  });

  it("writes no cache record when Scan is incompatible", async () => {
    await expect(
      runFastScanGate(
        source(),
        { posture: "enterprise" },
        { cacheHome, scanExecution: createSelfCompletingFakeScanAdapterForTests({}) },
      ),
    ).rejects.toBeInstanceOf(ScanPackageRefusalError);
    expect(existsSync(join(cacheHome, "scan-cache"))).toBe(false);
  });

  it("writes no cache record for a cancelled run", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFastScanGate(
        source(),
        { posture: "enterprise" },
        { cacheHome, scanExecution: fakeBindingGateScan(), signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(TrustScanCancelledError);
    expect(existsSync(join(cacheHome, "scan-cache"))).toBe(false);
  });
});
