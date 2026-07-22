import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClosureInput,
  type ClosureSpec,
  classificationOf,
  classifyClosure,
  fullTreeClosureSpec,
  type HostLoadFacts,
} from "../../src/binding/closure/profile-closure.js";
import {
  type AcceptedContentFinding,
  assertProvisionAuthorized,
  BindingScanError,
  type DimensionInspector,
  resolveGitSource,
  runFastScanGate,
  type ScanDisposition,
  scanAcceptanceReport,
  scannableFromGit,
} from "../../src/binding/scan-gate.js";
import { defaultRunner } from "../../src/internals/proc.js";

// The measured R4 host fact (evidence: evidence-w5-spike/2b-r4-nested-loader.json):
// claude-code@2.1.214 does NOT register a SKILL.md nested inside a repo-shaped
// skills subtree — Regime A. `readsNonSkillSkillFiles` false is the conservative
// unmeasured value; per the pinned adjacency semantics it must NOT expand nested
// repo-copy files while `registersNestedSkillMd` is false.
const HOST_FACTS_A: HostLoadFacts = {
  hostVersion: "claude-code@2.1.214",
  registersNestedSkillMd: false,
  readsNonSkillSkillFiles: false,
  probeEvidence: "evidence-w5-spike/2b-r4-nested-loader.json",
};

function inputOf(files: Record<string, string>): ClosureInput {
  return { files: Object.keys(files), readText: (path) => files[path] };
}

function seeded(seeds: ClosureSpec["seeds"]): ClosureSpec {
  return { profile: "test", classifierVersion: 1, mode: "seeded", seeds };
}

describe("profile closure classifier (rule-10 reachability, not location)", () => {
  it("fixture 1 — a flagged file reached by nothing is materialized-inert (non-blocking)", () => {
    const closure = classifyClosure(
      inputOf({ "entry.sh": "#!/bin/bash\necho hi\n", "fixtures/evil.md": "hidden payload\n" }),
      seeded([{ path: "entry.sh", reachability: "control" }]),
      HOST_FACTS_A,
    );
    expect(classificationOf(closure, "fixtures/evil.md").classification).toBe("materialized-inert");
    expect(classificationOf(closure, "entry.sh").classification).toBe("closure");
    expect(classificationOf(closure, "entry.sh").reachability).toBe("control");
  });

  it("fixture 2 — MOVING the flagged file into an entry-point path restores the block", () => {
    // The flagged file IS the seed (moved into an entry point).
    const closure = classifyClosure(
      inputOf({ "entry.sh": "#!/bin/bash\nhidden payload\n" }),
      seeded([{ path: "entry.sh", reachability: "control" }]),
      HOST_FACTS_A,
    );
    expect(classificationOf(closure, "entry.sh").classification).toBe("closure");
  });

  it("fixture 3 — REFERENCING the flagged file from a closure file restores the block", () => {
    const closure = classifyClosure(
      inputOf({
        "entry.sh": "#!/bin/bash\nsource lib/util.sh\n",
        "lib/util.sh": "hidden payload\n",
      }),
      seeded([{ path: "entry.sh", reachability: "control" }]),
      HOST_FACTS_A,
    );
    const util = classificationOf(closure, "lib/util.sh");
    expect(util.classification).toBe("closure");
    expect(util.reachability).toBe("control");
  });

  it("build-input edges carry through TS imports (browse/src analog)", () => {
    const closure = classifyClosure(
      inputOf({
        "browse/src/index.ts": 'import { x } from "./util.js";\nexport const y = x;\n',
        "browse/src/util.ts": "export const x = 1;\n",
      }),
      seeded([{ path: "browse/src/index.ts", reachability: "build-input" }]),
      HOST_FACTS_A,
    );
    expect(classificationOf(closure, "browse/src/util.ts").reachability).toBe("build-input");
  });

  it("model-loaded adjacency — a seed SKILL.md's referenced sections file is pulled in", () => {
    // Amendment 1: adjacency of a REGISTERED wrapper skill is covered by seed
    // extraction regardless of readsNonSkillSkillFiles.
    const closure = classifyClosure(
      inputOf({
        "qa/SKILL.md": "Run the checks in `sections/detail.md` before shipping.\n",
        "qa/sections/detail.md": "hidden payload\n",
      }),
      seeded([{ path: "qa/SKILL.md", reachability: "model-loaded" }]),
      HOST_FACTS_A,
    );
    expect(classificationOf(closure, "qa/sections/detail.md").reachability).toBe("model-loaded");
  });

  it("fixture 4 — unresolved dynamic reference blocks via directory widening", () => {
    const closure = classifyClosure(
      inputOf({
        "entry.sh": '#!/bin/bash\n. "plugins/$name.sh"\nsource "$DIR/$dynamic"\n',
        "plugins/evil.sh": "hidden payload\n",
      }),
      seeded([{ path: "entry.sh", reachability: "control" }]),
      HOST_FACTS_A,
    );
    const evil = classificationOf(closure, "plugins/evil.sh");
    expect(evil.classification).toBe("closure");
    expect(evil.reachability).toBe("unknown");
    expect(closure.unresolvedRefs).toContain("$DIR/$dynamic");
  });

  it("fixture 5 — a test/ path is NOT inert when it is actually reached (location != inertness)", () => {
    const closure = classifyClosure(
      inputOf({
        "entry.sh": "#!/bin/bash\nsource test/reached.sh\n",
        "test/reached.sh": "hidden payload\n",
        "test/unreached.sh": "hidden payload\n",
      }),
      seeded([{ path: "entry.sh", reachability: "control" }]),
      HOST_FACTS_A,
    );
    expect(classificationOf(closure, "test/reached.sh").classification).toBe("closure");
    expect(classificationOf(closure, "test/unreached.sh").classification).toBe(
      "materialized-inert",
    );
  });

  it("fixture 6 — host fact absent ⇒ nested files block; measured false ⇒ inert", () => {
    const files = inputOf({
      "entry.sh": "#!/bin/bash\necho hi\n",
      "skills/framework/inner/SKILL.md": "hidden payload\n",
      "skills/framework/inner/other.md": "hidden payload\n",
    });
    const spec = seeded([{ path: "entry.sh", reachability: "control" }]);

    const absent = classifyClosure(files, spec, undefined);
    expect(classificationOf(absent, "skills/framework/inner/SKILL.md").classification).toBe(
      "closure",
    );
    expect(classificationOf(absent, "skills/framework/inner/SKILL.md").reachability).toBe(
      "unknown",
    );
    expect(absent.hostFactsDigest).toBe("absent");

    const measured = classifyClosure(files, spec, HOST_FACTS_A);
    expect(classificationOf(measured, "skills/framework/inner/SKILL.md").classification).toBe(
      "materialized-inert",
    );
  });

  it("fixture 11 — classification is deterministic (identical closureDigest across runs)", () => {
    const files = inputOf({
      "entry.sh": "#!/bin/bash\nsource lib/util.sh\n",
      "lib/util.sh": "echo ok\n",
      "docs/README.md": "docs\n",
    });
    const spec = seeded([{ path: "entry.sh", reachability: "control" }]);
    const first = classifyClosure(files, spec, HOST_FACTS_A);
    const second = classifyClosure(files, spec, HOST_FACTS_A);
    expect(second.closureDigest).toBe(first.closureDigest);
  });

  it("full-tree closure classifies every file as blocking control (W4 back-compat model)", () => {
    const closure = classifyClosure(
      inputOf({ "a.ts": "export const a = 1;\n", "test/b.ts": "export const b = 2;\n" }),
      fullTreeClosureSpec(),
      HOST_FACTS_A,
    );
    expect(classificationOf(closure, "a.ts").classification).toBe("closure");
    expect(classificationOf(closure, "test/b.ts").classification).toBe("closure");
    expect(classificationOf(closure, "test/b.ts").reachability).toBe("control");
  });

  it("host-fact validity binds to the host tuple (hostVersion folded into both digests)", () => {
    const files = inputOf({ "entry.sh": "#!/bin/bash\necho hi\n" });
    const spec = seeded([{ path: "entry.sh", reachability: "control" }]);
    const onA = classifyClosure(files, spec, HOST_FACTS_A);
    const onB = classifyClosure(files, spec, { ...HOST_FACTS_A, hostVersion: "claude-code@9.9.9" });
    expect(onA.hostFactsDigest).not.toBe(onB.hostFactsDigest);
    expect(onA.closureDigest).not.toBe(onB.closureDigest);
  });

  it("fixture 8b — scanAcceptanceReport flags an out-of-closure acceptance as stale", () => {
    const closure = classifyClosure(
      inputOf({ "qa/SKILL.md": "# qa\nclean body\n", "notes/inert.md": "hidden payload\n" }),
      {
        profile: "gstack:test",
        classifierVersion: 1,
        mode: "seeded",
        seeds: [{ path: "qa/SKILL.md", reachability: "model-loaded" }],
      },
      HOST_FACTS_A,
    );
    const inClosure: AcceptedContentFinding = {
      repository: "test/gstack",
      code: "trust.hidden-unicode",
      path: "qa/SKILL.md",
      fileSha256: "a".repeat(64),
      profile: "gstack:test",
    };
    const outOfClosure: AcceptedContentFinding = {
      repository: "test/gstack",
      code: "trust.hidden-unicode",
      path: "notes/inert.md",
      fileSha256: "b".repeat(64),
      profile: "gstack:test",
    };
    const report = scanAcceptanceReport(closure, [inClosure, outOfClosure]);
    expect(report.applicable.map((entry) => entry.path)).toEqual(["qa/SKILL.md"]);
    expect(report.staleOutOfClosure.map((entry) => entry.path)).toEqual(["notes/inert.md"]);
  });
});

// -- Gate-level closure behavior (runFastScanGate over a real checkout) -------

const ZWSP = String.fromCharCode(0x200b);
const CLEAN_SKILL = "# qa skill\n\nnothing to see here\n";
const REF_SKILL = "# qa skill\n\nRun the steps in `sections/detail.md` before shipping.\n";
const HIDDEN = `body with a zero${ZWSP}width instruction\n`;
const GSTACK_PROFILE = "gstack:test";

function sha256Lf(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function gstackClosureSpec(): ClosureSpec {
  return {
    profile: GSTACK_PROFILE,
    classifierVersion: 1,
    mode: "seeded",
    seeds: [{ path: "qa/SKILL.md", reachability: "model-loaded" }],
  };
}

describe("closure-aware gate (dual outcomes + rule-3/8/10 at the gate)", () => {
  let cacheHome: string;
  let repoDir: string;

  function git(dir: string, args: string[]): void {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  }

  function initGitRepo(dir: string, files: Record<string, string>): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Closure Test"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
  }

  async function gateOver(
    files: Record<string, string>,
    policy: Parameters<typeof runFastScanGate>[1],
  ): Promise<ScanDisposition> {
    initGitRepo(repoDir, files);
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    return runFastScanGate(scannableFromGit(resolved), policy, { cacheHome });
  }

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), "aih-closure-cache-"));
    repoDir = mkdtempSync(join(tmpdir(), "aih-closure-repo-"));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("rule 3 — an inert high finding is reported, not gated (ALLOW with FINDINGS_PRESENT)", async () => {
    const disposition = await gateOver(
      { "qa/SKILL.md": CLEAN_SKILL, "notes/inert.md": HIDDEN },
      { posture: "vibe", closureSpec: gstackClosureSpec(), hostFacts: HOST_FACTS_A },
    );
    expect(disposition.selectedProfileGate).toBe("ALLOW");
    expect(disposition.verdict).toBe("allow");
    expect(disposition.rawSourceScan).toBe("FINDINGS_PRESENT");
    const inert = disposition.findings.find((f) => f.path === "notes/inert.md");
    expect(inert?.classification).toBe("materialized-inert");
    expect(disposition.disclosure.inertFindings.high).toBeGreaterThan(0);
    expect(disposition.disclosure.residualRisk.blockingUnaccepted).toBe(0);
  });

  it("rule 10 — the SAME finding blocks once its file is referenced into the closure", async () => {
    const disposition = await gateOver(
      { "qa/SKILL.md": REF_SKILL, "qa/sections/detail.md": HIDDEN },
      { posture: "vibe", closureSpec: gstackClosureSpec(), hostFacts: HOST_FACTS_A },
    );
    expect(disposition.selectedProfileGate).toBe("BLOCK");
    const reached = disposition.findings.find((f) => f.path === "qa/sections/detail.md");
    expect(reached?.classification).toBe("closure");
    expect(reached?.closureReachability).toBe("model-loaded");
  });

  it("fixture 7 — an accepted runtime finding yields ALLOW_WITH_CONDITIONS and authorizes", async () => {
    const accept: AcceptedContentFinding = {
      repository: "test/gstack",
      code: "trust.hidden-unicode",
      path: "qa/sections/detail.md",
      fileSha256: sha256Lf(HIDDEN),
      profile: GSTACK_PROFILE,
    };
    const disposition = await gateOver(
      { "qa/SKILL.md": REF_SKILL, "qa/sections/detail.md": HIDDEN },
      {
        posture: "vibe",
        closureSpec: gstackClosureSpec(),
        hostFacts: HOST_FACTS_A,
        acceptedFindings: [accept],
      },
    );
    expect(disposition.selectedProfileGate).toBe("ALLOW_WITH_CONDITIONS");
    expect(disposition.verdict).toBe("allow");
    const accepted = disposition.findings.find((f) => f.path === "qa/sections/detail.md");
    expect(accepted?.accepted).toBe(true);
    expect(disposition.closure?.requiredAcceptanceKeys?.length ?? 0).toBeGreaterThan(0);
    expect(() => assertProvisionAuthorized(disposition, disposition.digest)).not.toThrow();
  });

  it("fixture 8a — accepting an inert finding is a structural no-op (still ALLOW, not marked)", async () => {
    const accept: AcceptedContentFinding = {
      repository: "test/gstack",
      code: "trust.hidden-unicode",
      path: "notes/inert.md",
      fileSha256: sha256Lf(HIDDEN),
      profile: GSTACK_PROFILE,
    };
    const disposition = await gateOver(
      { "qa/SKILL.md": CLEAN_SKILL, "notes/inert.md": HIDDEN },
      {
        posture: "vibe",
        closureSpec: gstackClosureSpec(),
        hostFacts: HOST_FACTS_A,
        acceptedFindings: [accept],
      },
    );
    expect(disposition.selectedProfileGate).toBe("ALLOW");
    const inert = disposition.findings.find((f) => f.path === "notes/inert.md");
    expect(inert?.classification).toBe("materialized-inert");
    expect(inert?.accepted).toBeUndefined();
  });

  it("host fact absent ⇒ the inert file becomes unknown and the gate BLOCKS", async () => {
    const disposition = await gateOver(
      { "qa/SKILL.md": CLEAN_SKILL, "notes/inert.md": HIDDEN },
      { posture: "vibe", closureSpec: gstackClosureSpec(), hostFacts: undefined },
    );
    expect(disposition.selectedProfileGate).toBe("BLOCK");
    const nowUnknown = disposition.findings.find((f) => f.path === "notes/inert.md");
    expect(nowUnknown?.closureReachability).toBe("unknown");
    expect(disposition.closure?.hostFactsDigest).toBe("absent");
  });

  it("fixture 10 — a critical finding is never inert, even in a materialized file", async () => {
    const criticalInInertFile: DimensionInspector = {
      dimension: "test-critical-inert",
      run: () => ({
        dimension: "test-critical-inert",
        status: "produced",
        findings: [
          {
            code: "trust.malicious-code",
            severity: "critical",
            detail: "boom",
            coverage: "complete",
            path: "notes/inert.md",
            contentSha256: "ab".repeat(32),
          },
        ],
      }),
    };
    initGitRepo(repoDir, { "qa/SKILL.md": CLEAN_SKILL, "notes/inert.md": "clean\n" });
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const disposition = runFastScanGate(
      scannableFromGit(resolved),
      {
        posture: "vibe",
        allowIncompleteAtVibe: true,
        closureSpec: gstackClosureSpec(),
        hostFacts: HOST_FACTS_A,
      },
      { cacheHome, inspectors: [criticalInInertFile] },
    );
    expect(disposition.selectedProfileGate).toBe("BLOCK");
    const critical = disposition.findings.find((f) => f.code === "trust.malicious-code");
    expect(critical?.classification).toBe("closure");
  });

  // -- rule-8 visible-typography demotion at the gate -----------------------

  const BANNER_TS = "/*\n * ────────────────────\n * banner\n */\nexport const value = 1;\n";

  function tsBuildInputSpec(): ClosureSpec {
    return {
      profile: GSTACK_PROFILE,
      classifierVersion: 1,
      mode: "seeded",
      seeds: [{ path: "browse/src/index.ts", reachability: "build-input" }],
    };
  }

  it("rule 8 — an all-advisory closure file demotes to advisory (ALLOW; raw high preserved)", async () => {
    const disposition = await gateOver(
      { "browse/src/index.ts": BANNER_TS },
      { posture: "vibe", closureSpec: tsBuildInputSpec(), hostFacts: HOST_FACTS_A },
    );
    expect(disposition.selectedProfileGate).toBe("ALLOW");
    expect(disposition.rawSourceScan).toBe("FINDINGS_PRESENT");
    expect(disposition.disclosure.visibleTypographyAdvisories.total).toBeGreaterThan(0);
    expect(disposition.disclosure.visibleTypographyAdvisories.files).toBeGreaterThan(0);
    expect(disposition.disclosure.closureFindings.high).toBe(0);
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.severity).toBe("high"); // raw detector severity preserved
    expect(finding?.advisory?.reclassifiedFrom).toBe("high");
    expect(finding?.advisory?.contextClass).toBe("comment");
  });

  it("rule 8 — the legacy (no closureSpec) path does NOT reclassify; the same file BLOCKS", async () => {
    const disposition = await gateOver({ "browse/src/index.ts": BANNER_TS }, { posture: "vibe" });
    expect(disposition.verdict).toBe("block");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.advisory).toBeUndefined();
  });

  it("rule 8 — per-file roll-up: one code-position char keeps the whole file blocking", async () => {
    // advisory box-drawing comment PLUS a box-drawing char at a code position.
    const mixed = "/*\n * ─────\n */\nconst ─ = 1;\n";
    const disposition = await gateOver(
      { "browse/src/index.ts": mixed },
      { posture: "vibe", closureSpec: tsBuildInputSpec(), hostFacts: HOST_FACTS_A },
    );
    expect(disposition.selectedProfileGate).toBe("BLOCK");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.advisory).toBeUndefined();
  });

  it("rule 8 — a W4 full-tree closure does NOT reclassify (byte-identical: the file BLOCKS)", async () => {
    const disposition = await gateOver(
      { "browse/src/index.ts": BANNER_TS },
      { posture: "vibe", closureSpec: fullTreeClosureSpec(), hostFacts: HOST_FACTS_A },
    );
    expect(disposition.verdict).toBe("block");
    const finding = disposition.findings.find((f) => f.code === "trust.hidden-unicode");
    expect(finding?.advisory).toBeUndefined();
  });
});

// -- W4 full-tree regression (fixture 9): outcomes unchanged vs legacy --------

describe("W4 full-tree closure reproduces the legacy verdict (byte-identical outcome)", () => {
  let cacheHome: string;
  let repoDir: string;

  function initGitRepo(dir: string, files: Record<string, string>): void {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "W4 Test"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  }

  async function bothGates(
    files: Record<string, string>,
    accepted?: readonly AcceptedContentFinding[],
  ): Promise<{ legacy: ScanDisposition; fullTree: ScanDisposition }> {
    initGitRepo(repoDir, files);
    const resolved = await resolveGitSource(
      { repository: repoDir, ref: "HEAD" },
      { runner: defaultRunner, cacheHome },
    );
    const src = scannableFromGit(resolved);
    const legacy = runFastScanGate(
      src,
      { posture: "vibe", acceptedFindings: accepted },
      { cacheHome },
    );
    const fullTree = runFastScanGate(
      src,
      {
        posture: "vibe",
        acceptedFindings: accepted,
        closureSpec: fullTreeClosureSpec(),
        hostFacts: HOST_FACTS_A,
      },
      { cacheHome },
    );
    return { legacy, fullTree };
  }

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), "aih-w4-cache-"));
    repoDir = mkdtempSync(join(tmpdir(), "aih-w4-repo-"));
  });

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("an unaccepted high blocks under both legacy and full-tree closure", async () => {
    const { legacy, fullTree } = await bothGates({
      "SKILL.md": `# s\n${HIDDEN}`,
      "README.md": "hi\n",
    });
    expect(legacy.verdict).toBe("block");
    expect(fullTree.verdict).toBe("block");
    expect(fullTree.verdict).toBe(legacy.verdict);
  });

  it("an accepted high allows under both; full-tree names it a condition and still authorizes", async () => {
    const skill = `# s\n${HIDDEN}`;
    // Unscoped acceptance (no `profile`) — the W4 default that applies under full-tree.
    const accepted: AcceptedContentFinding[] = [
      {
        repository: "test/w4",
        code: "trust.hidden-unicode",
        path: "SKILL.md",
        fileSha256: sha256Lf(skill),
      },
    ];
    const { legacy, fullTree } = await bothGates(
      { "SKILL.md": skill, "README.md": "hi\n" },
      accepted,
    );
    expect(legacy.verdict).toBe("allow");
    expect(fullTree.verdict).toBe("allow");
    expect(fullTree.verdict).toBe(legacy.verdict);
    expect(fullTree.selectedProfileGate).toBe("ALLOW_WITH_CONDITIONS");
    expect(() => assertProvisionAuthorized(legacy, legacy.digest)).not.toThrow();
    expect(() => assertProvisionAuthorized(fullTree, fullTree.digest)).not.toThrow();
  });

  it("a block disposition refuses provisioning under both models", async () => {
    const { legacy, fullTree } = await bothGates({ "SKILL.md": `# s\n${HIDDEN}` });
    expect(() => assertProvisionAuthorized(legacy, legacy.digest)).toThrow(BindingScanError);
    expect(() => assertProvisionAuthorized(fullTree, fullTree.digest)).toThrow(BindingScanError);
  });
});
