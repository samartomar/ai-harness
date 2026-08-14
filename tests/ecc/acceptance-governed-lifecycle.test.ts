import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import type {
  BaselineAuthorization,
  BaselineHeldComponent,
} from "../../src/baseline-evidence/verify.js";
import type { EccComponentId } from "../../src/ecc/components.js";
import { walkManagedRoot } from "../../src/ecc/install-manifest.js";
import {
  applyEccMaterialization,
  eccMaterializationReceiptPath,
  previewEccMaterialization,
  uninstallEccMaterialization,
} from "../../src/ecc/materialization.js";
import { readEccMaterializationReceipt } from "../../src/ecc/materialization-receipt.js";
import {
  type EccEffectiveSelectionResult,
  resolveEccMaterializationSelection,
} from "../../src/ecc/materialization-selection.js";
import {
  type EccClaudeMaterializationResult,
  resolveEccClaudeMaterialization,
} from "../../src/ecc/materialization-target-claude.js";
import { resolveVerifiedKiroMaterialization } from "../../src/ecc/materialization-target-kiro.js";
import { eccComponentSourcePaths } from "../../src/ecc/materialize.js";
import { resolveEffectiveOrgPolicy } from "../../src/org-policy/effective.js";
import { orgPolicyPath, readOrgPolicy } from "../../src/org-policy/schema.js";

/**
 * The representative acceptance journey for the governed framework lifecycle,
 * runnable as one command against temporary fixture roots:
 *
 *   npx vitest run tests/ecc/acceptance-governed-lifecycle.test.ts
 *
 * Author a governed policy selecting components from one framework; parse it
 * through the real entry point; resolve the evidence-passed effective
 * selection and see what each excluded component reports and why; map the
 * included components onto the Claude target and see what it refuses;
 * preview and see nothing written; apply and see the component files land
 * with their ownership receipt; apply again and see nothing change; uninstall
 * and see the owned bytes gone with operator content untouched.
 *
 * Everything runs against the fixture roots created below — never against a
 * real checkout.
 *
 * ── WHAT THIS JOURNEY DOES NOT EXERCISE ────────────────────────────────────
 * Stated plainly, because a journey that overstates its coverage is worse than
 * a narrower one.
 *
 * 1. NO CLI PROCESS. Nothing here spawns a product command. The journey calls
 *    the same exported functions a command would call, in the order a command
 *    would call them, but no `aih` binary runs and no product CLI is ever
 *    pointed at a checkout. Whether an operator can DISCOVER or TRIGGER this
 *    is not proven HERE — command wiring now exists (`aih ecc --lifecycle
 *    install` and `aih uninstall`), and it is pinned in
 *    `tests/ecc/governed-lifecycle-command.test.ts` and
 *    `tests/uninstall/ecc-materialization.test.ts`.
 * 2. CLAUDE ONLY. Claude is the first target in the verification order; Codex,
 *    Kimi, Cursor and OpenCode are follow-up rows and nothing here says
 *    anything about them.
 * 3. PROJECT ROOT ONLY. The governed materialization root is the project root
 *    by ruling — the ownership receipt lives INSIDE the root it describes, so
 *    a receipt in a machine-wide home root would claim bytes on behalf of
 *    every repository on that machine. Home-scoped installation stays the
 *    framework's own installer's business and is out of scope here; the
 *    target adapter refuses a home-scoped destination outright.
 * 4. A BUILT FIXTURE, NOT A PINNED CHECKOUT. The source tree below is written
 *    by this test. Upstream path shapes that exist in a real pinned checkout
 *    but not in this fixture are unproven, and so is anything about the real
 *    pin's contents.
 * 5. NO AUTHORING SURFACE. The workbench, its selection rows and the
 *    fulfillment annotation are not opened or rendered here; this journey
 *    starts from an already-authored policy document.
 * 6. NO REPAIR, NO LEDGER WRITER. Only preview, apply, re-apply and uninstall
 *    are walked. The engine's repair path is untouched, and the machine
 *    registration ledger — offered to a caller through a callback — has no
 *    writer wired in this journey.
 * 7. NO DRIFT OR DAMAGE PATHS. A hand-edited owned file, an unreadable
 *    destination and a malformed receipt all have defined behavior in the
 *    engine and none of it is walked here; this is the clean journey.
 */

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";

/** Bytes with an embedded zero byte, so a match proves bytes and not text. */
const BINARY_ASSET = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);

/** The pinned framework checkout, shaped like the real one for the paths walked. */
const SOURCE_TREE: Readonly<Record<string, string | Buffer>> = {
  "agents/code-reviewer.md": "# code-reviewer\n",
  "agents/planner.md": "# planner\n",
  "skills/tdd-workflow/SKILL.md": "# tdd-workflow\n",
  "skills/tdd-workflow/assets/marker.bin": BINARY_ASSET,
  ".agents/skills/tdd-workflow/SKILL.md": "# tdd-workflow (agent copy)\n",
  "skills/verification-loop/SKILL.md": "# verification-loop\n",
  ".agents/skills/verification-loop/SKILL.md": "# verification-loop (agent copy)\n",
  "rules/README.md": "# rules\n",
  "rules/common/coding-style.md": "# coding style\n",
  ".mcp.json": '{"mcpServers":{}}\n',
  "mcp-configs/mcp-servers.json": '{"servers":{}}\n',
  ".kiro/agents/code-reviewer.json":
    '{"name":"code-reviewer","mcpServers":{},"hooks":{},"prompt":"CLI agent"}\n',
};

/** Operator content on the destination root, present before anything is applied. */
const OPERATOR_TREE: Readonly<Record<string, string>> = {
  // The client settings file this lifecycle deliberately does not own.
  ".claude/settings.json": '{\n    "env": {"OPERATOR": "1"}\n}\n',
  // Operator files INSIDE directories AIH writes into — the case that decides
  // whether "operator content survives" means anything.
  ".claude/agents/operator-agent.md": "# my own agent\n",
  ".claude/skills/tdd-workflow/OPERATOR-NOTES.md": "# my notes on this skill\n",
  "notes/OPERATOR.md": "# keep me\n",
};

interface SelectionFixture {
  kind: string;
  id: string;
  path: string;
}

/** Evidence-passed: these materialize. */
const PASSED: readonly SelectionFixture[] = [
  { kind: "agent", id: "agent:code-reviewer", path: "agents/code-reviewer.md" },
  { kind: "skill", id: "skill:tdd-workflow", path: "skills/tdd-workflow" },
  { kind: "baseline", id: "baseline:rules", path: "rules" },
];
/** Selected, vetted, and blocked by the vet: visible, selectable, never materialized. */
const BLOCKED: SelectionFixture = {
  kind: "agent",
  id: "agent:planner",
  path: "agents/planner.md",
};
/** Selected with no evidence recorded at the pin: a different reason, not the same one. */
const UNVETTED: SelectionFixture = {
  kind: "skill",
  id: "skill:verification-loop",
  path: "skills/verification-loop",
};
/** Evidence-passed, but its content lands on a surface another AIH lifecycle owns. */
const OTHER_LIFECYCLE: SelectionFixture = {
  kind: "mcp",
  id: "mcp:github",
  path: "mcp-configs/mcp-servers.json",
};

/** What must land, and from which source file, once the journey applies. */
const MATERIALIZED: ReadonlyArray<{
  id: string;
  files: ReadonlyArray<{ source: string; destination: string }>;
}> = [
  {
    id: "agent:code-reviewer",
    files: [{ source: "agents/code-reviewer.md", destination: ".claude/agents/code-reviewer.md" }],
  },
  {
    id: "baseline:rules",
    files: [
      { source: "rules/README.md", destination: ".claude/rules/README.md" },
      {
        source: "rules/common/coding-style.md",
        destination: ".claude/rules/common/coding-style.md",
      },
    ],
  },
  {
    id: "skill:tdd-workflow",
    files: [
      {
        source: ".agents/skills/tdd-workflow/SKILL.md",
        destination: ".agents/skills/tdd-workflow/SKILL.md",
      },
      {
        source: "skills/tdd-workflow/SKILL.md",
        destination: ".claude/skills/tdd-workflow/SKILL.md",
      },
      {
        source: "skills/tdd-workflow/assets/marker.bin",
        destination: ".claude/skills/tdd-workflow/assets/marker.bin",
      },
    ],
  },
];

const MATERIALIZED_FILE_COUNT = MATERIALIZED.reduce(
  (total, component) => total + component.files.length,
  0,
);

let sourceRoot: string;
let root: string;

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "aih-acceptance-lifecycle-source-"));
  writeTree(sourceRoot, SOURCE_TREE);
  root = mkdtempSync(join(tmpdir(), "aih-acceptance-lifecycle-root-"));
  writeTree(root, OPERATOR_TREE);
});
afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeTree(base: string, tree: Readonly<Record<string, string | Buffer>>): void {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(base, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

function bytesAt(base: string, path: string): Buffer {
  return readFileSync(join(base, ...path.split("/")));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every regular file under a root, by path, with its content digest. */
function snapshot(base: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const path of walkManagedRoot(base)) entries[path] = sha256(bytesAt(base, path));
  return entries;
}

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: REPOSITORY,
    pinnedSha: COMMIT,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

function blockedEvidence(componentId: string): BaselineHeldComponent {
  return {
    componentId,
    routeCode: "baseline.evidence-blocked",
    codes: ["malicious-code"],
    details: [`${componentId} is blocked by signed evidence (malicious-code)`],
  };
}

/**
 * Steps 2-4, as a caller would run them: read and parse the authored policy,
 * resolve the effective policy, resolve the evidence-passed effective
 * selection, and map it onto the Claude target.
 *
 * Deliberately re-runnable, because "apply again" is a SECOND run of the whole
 * chain and not a second call to the engine with a cached input. A chain that
 * is only deterministic when its inputs are computed once has not been shown
 * to be deterministic at all.
 */
function resolveChain(): {
  selection: EccEffectiveSelectionResult;
  target: EccClaudeMaterializationResult;
} {
  // The real entry point: a policy DOCUMENT on disk, read and parsed by the
  // product's own reader. The resolver is only safe when its input arrived
  // this way, so the journey never hands it a policy-shaped object.
  const policy = readOrgPolicy(root, {});
  if (policy === undefined) throw new Error("expected the authored policy to parse");
  const effective = resolveEffectiveOrgPolicy(policy);

  const selection = resolveEccMaterializationSelection(effective, {
    authorizations: [...PASSED, OTHER_LIFECYCLE].map((item) => authorization(item.id)),
    held: [blockedEvidence(BLOCKED.id)],
  });
  const target = resolveEccClaudeMaterialization({ sourceRoot, components: selection.included });
  return { selection, target };
}

describe("acceptance — the governed framework lifecycle on a temporary fixture root", () => {
  it("author → parse → evidence-passed selection → Claude target → preview → apply → re-apply → uninstall", () => {
    // ── 1. Author. One framework, six selected components: three whose
    // evidence passed, one the vet blocked, one with no evidence recorded at
    // the pin, and one whose content lands on a surface another AIH lifecycle
    // owns. Selecting records intent; nothing about selection installs.
    writeFileSync(
      orgPolicyPath(root, {}),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          governance: {
            policyVersion: "2026-08-07.acceptance",
            supportedClis: ["claude"],
            catalog: { reviewed: [], custom: [] },
            externalSelections: [
              {
                framework: "ecc",
                items: [...PASSED, BLOCKED, UNVETTED, OTHER_LIFECYCLE].map((item) => ({
                  kind: item.kind,
                  id: item.id,
                  source: { repository: REPOSITORY, commit: COMMIT, path: item.path },
                })),
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // ── 2 & 3. Parse through the real entry point, resolve the effective
    // policy, and resolve the evidence-passed effective selection.
    const { selection, target } = resolveChain();

    // Exactly the four components with a passing authorization reach
    // `included` — evidence, not selection, is what admits a component.
    expect(selection.included.map((component) => component.id)).toEqual([
      ...PASSED.map((item) => item.id),
      OTHER_LIFECYCLE.id,
    ]);
    // Each excluded component reports WHY, and the two reasons stay distinct:
    // a vet-blocked component is not the same thing as one whose evidence was
    // never recorded, and collapsing them would hide a real finding behind a
    // missing one. Both keep their vet finding codes.
    expect(
      selection.excluded.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        findingCodes: entry.findingCodes,
      })),
    ).toEqual([
      { id: BLOCKED.id, reason: "vet-blocked", findingCodes: ["malicious-code"] },
      { id: UNVETTED.id, reason: "no-evidence", findingCodes: [] },
    ]);
    expect(selection.excluded.map((entry) => entry.detail)).toEqual([
      `${BLOCKED.id} is blocked by signed evidence (malicious-code)`,
      `no evidence recorded for ${UNVETTED.id} at ${REPOSITORY}@${COMMIT.slice(0, 12)}`,
    ]);

    // ── 4. Map onto the Claude target. Evidence passing is necessary and not
    // sufficient: a component whose content lands on a destination another AIH
    // lifecycle owns is refused here, by name and with its reason, rather than
    // materialized or silently dropped.
    expect(target.refused).toEqual([
      {
        id: OTHER_LIFECYCLE.id,
        reason: "unowned-destination",
        detail: "the Claude target owns no content destination for .mcp.json",
      },
    ]);
    // The target carries the resolver's order through untouched — the order the
    // administrator declared, not a re-sorted one. (The ownership receipt sorts
    // by id when it is written; that is asserted separately below, and the two
    // orders differ here on purpose so neither assertion can stand in for the
    // other.)
    expect(target.components.map((component) => component.id)).toEqual(
      PASSED.map((item) => item.id),
    );

    // ── 5. Preview. Preview-first means preview writes NOTHING, and the
    // assertion is over a plan that genuinely has work in it — an empty plan
    // would satisfy "wrote nothing" while proving nothing.
    const before = snapshot(root);
    const preview = previewEccMaterialization({ root, components: target.components });
    expect(preview.write).toHaveLength(MATERIALIZED_FILE_COUNT);
    expect(preview.subtract).toEqual([]);
    expect(preview.advisories).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);

    // ── 6. Apply. THE POSITIVE CONTROL: what should materialize, did — every
    // destination present and byte-equal to the source file it came from,
    // including the one that is not text.
    const applied = applyEccMaterialization({ root, components: target.components });
    expect(applied.written).toHaveLength(MATERIALIZED_FILE_COUNT);
    for (const component of MATERIALIZED) {
      for (const file of component.files) {
        expect(
          bytesAt(root, file.destination).equals(bytesAt(sourceRoot, file.source)),
          `${component.id} -> ${file.destination}`,
        ).toBe(true);
      }
    }
    // Neither excluded component reached a destination, and neither did the
    // one the target refused.
    expect(existsSync(join(root, ".claude", "agents", "planner.md"))).toBe(false);
    expect(existsSync(join(root, ".claude", "skills", "verification-loop"))).toBe(false);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, "mcp-configs"))).toBe(false);

    // The receipt records each component with its per-file ownership: the
    // destination path, the digest of the exact bytes written, and the
    // operation kind that decides how removal works. Compared as a map so the
    // assertion is about content rather than an assumed ordering.
    const read = readEccMaterializationReceipt(root);
    if (read.state !== "valid") throw new Error(`expected a valid receipt, got ${read.state}`);
    expect(read.receipt.components.map((component) => component.id)).toEqual(
      MATERIALIZED.map((component) => component.id),
    );
    for (const component of MATERIALIZED) {
      const recorded = read.receipt.components.find((entry) => entry.id === component.id);
      expect(recorded?.provenance).toEqual({
        repository: REPOSITORY,
        commit: COMMIT,
        componentPath: PASSED.find((item) => item.id === component.id)?.path,
      });
      // Keyed by path, value is the WHOLE remaining ownership record — so a
      // merge-json entry, which would carry `ownedKeys` and `createdByAih`,
      // cannot pass as a whole-file one.
      expect(
        Object.fromEntries((recorded?.files ?? []).map(({ path, ...owned }) => [path, owned])),
      ).toEqual(
        Object.fromEntries(
          component.files.map((file) => [
            file.destination,
            { operation: "copy-file", contentSha256: sha256(bytesAt(sourceRoot, file.source)) },
          ]),
        ),
      );
    }

    // ── 7. Apply again — the whole chain re-run, not a cached input replayed.
    // Deterministic second apply: nothing rewritten, every byte under the root
    // identical, receipt included.
    const settled = snapshot(root);
    const second = applyEccMaterialization({ root, components: resolveChain().target.components });
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(MATERIALIZED_FILE_COUNT);
    expect(snapshot(root)).toEqual(settled);

    // ── 8. Uninstall. Owned bytes removed, ownership record gone, and every
    // piece of operator content byte-identical — including the two files the
    // operator placed INSIDE directories AIH wrote into, and the policy
    // document itself.
    const operatorBefore = Object.fromEntries(
      Object.keys(OPERATOR_TREE).map((path) => [path, bytesAt(root, path)]),
    );
    const policyBefore = readFileSync(orgPolicyPath(root, {}));

    const removed = uninstallEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed).toHaveLength(MATERIALIZED_FILE_COUNT);
    for (const component of MATERIALIZED) {
      for (const file of component.files) {
        expect(existsSync(join(root, ...file.destination.split("/"))), file.destination).toBe(
          false,
        );
      }
    }
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
    for (const [path, bytes] of Object.entries(operatorBefore)) {
      expect(bytesAt(root, path).equals(bytes), path).toBe(true);
    }
    expect(readFileSync(orgPolicyPath(root, {})).equals(policyBefore)).toBe(true);
  });
});

describe("acceptance — Kiro IDE and CLI variants share one governed target", () => {
  it("Kiro IDE and CLI variants share one governed target", () => {
    const id = "agent:code-reviewer";
    const selectedAuthorization: BaselineAuthorization = {
      ...authorization(id),
      treeSha256: hashComponentTree(sourceRoot, eccComponentSourcePaths(id as EccComponentId))
        .treeSha256,
    };
    const runtimeAuthorization: BaselineAuthorization = {
      ...authorization("runtime:ecc-kiro"),
      treeSha256: hashComponentTree(sourceRoot, [".kiro"]).treeSha256,
    };
    const resolve = () =>
      resolveVerifiedKiroMaterialization({
        sourceRoot,
        components: [
          {
            id: id as EccComponentId,
            authorization: selectedAuthorization,
            provenance: {
              repository: REPOSITORY,
              commit: COMMIT,
              componentPath: "agents/code-reviewer.md",
            },
          },
        ],
        evidence: {
          authorizations: [selectedAuthorization, runtimeAuthorization],
          held: [],
        },
      });
    const destinations = [".kiro/agents/code-reviewer.json", ".kiro/agents/code-reviewer.md"];

    const target = resolve();
    expect(target.components).toHaveLength(1);
    expect(target.components[0]?.files.map((file) => file.path)).toEqual(destinations);
    const before = snapshot(root);
    expect(previewEccMaterialization({ root, components: target.components }).write).toHaveLength(
      2,
    );
    expect(snapshot(root)).toEqual(before);

    expect(applyEccMaterialization({ root, components: target.components }).written).toHaveLength(
      2,
    );
    expect(
      bytesAt(root, destinations[0] as string).equals(
        bytesAt(sourceRoot, destinations[0] as string),
      ),
    ).toBe(true);
    expect(
      bytesAt(root, destinations[1] as string).equals(
        bytesAt(sourceRoot, "agents/code-reviewer.md"),
      ),
    ).toBe(true);
    const settled = snapshot(root);
    expect(applyEccMaterialization({ root, components: resolve().components }).written).toEqual([]);
    expect(snapshot(root)).toEqual(settled);

    const removed = uninstallEccMaterialization(root);
    expect(removed.removed.map((entry) => entry.path).sort()).toEqual([...destinations].sort());
    for (const destination of destinations)
      expect(existsSync(join(root, ...destination.split("/")))).toBe(false);
  });
});
