import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import type {
  BaselineAuthorization,
  BaselineHeldComponent,
} from "../../src/baseline-evidence/verify.js";
import type { EccComponentId } from "../../src/ecc/components.js";
import type { EccEffectiveSelectionComponent } from "../../src/ecc/materialization-selection.js";
import {
  foldedKiroProjectionCollision,
  kiroAgentSemanticIdentity,
  resolveVerifiedKiroMaterialization,
} from "../../src/ecc/materialization-target-kiro.js";
import { eccComponentSourcePaths } from "../../src/ecc/materialize.js";

const REPOSITORY = "affaan-m/ECC";
const COMMIT = "a".repeat(40);
const EVIDENCE = "c".repeat(64);
const SOURCE_TREE: Readonly<Record<string, string | Buffer>> = {
  "agents/code-reviewer.md": "# generic selected agent\n",
  "agents/code-architect.md": "# generic agent without a curated Kiro mapping\n",
  "skills/tdd-workflow/SKILL.md": "# generic selected skill\n",
  ".agents/skills/tdd-workflow/SKILL.md": "# agent selected skill\n",
  "rules/README.md": "# generic selected rules\n",
  "rules/common/coding-style.md": "# generic selected common rule\n",
  ".kiro/skills/tdd-workflow/SKILL.md": "# curated Kiro skill\n",
  ".kiro/skills/not-selected/SKILL.md": "# do not project\n",
  ".kiro/steering/security.md": "# security\n",
  ".kiro/steering/testing.md": "# testing\n",
  ".kiro/agents/code-reviewer.md": "---\nname: code-reviewer\n---\n\n# Markdown agent\n",
  ".kiro/agents/code-reviewer.json":
    '{"name":"code-reviewer","mcpServers":{},"hooks":{},"prompt":"JSON agent"}\n',
  ".kiro/hooks/on-save.json": "{}\n",
  ".kiro/scripts/format.sh": "exit 0\n",
  ".kiro/settings/mcp.json.example": "{}\n",
};

let sourceRoot: string;

function put(path: string, contents: string | Buffer): void {
  const absolute = join(sourceRoot, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function writeSource(): void {
  for (const [path, contents] of Object.entries(SOURCE_TREE)) put(path, contents);
}

function authorization(componentId: string, sourcePaths: readonly string[]): BaselineAuthorization {
  return {
    componentId,
    source: REPOSITORY,
    pinnedSha: COMMIT,
    treeSha256: hashComponentTree(sourceRoot, sourcePaths).treeSha256,
    tier: "vendor",
    issuer: "@aihq/core release",
    evidenceSha256: EVIDENCE,
  };
}

function selected(id: string, sourcePath: string): EccEffectiveSelectionComponent {
  return {
    id: id as EccComponentId,
    authorization: authorization(id, eccComponentSourcePaths(id as EccComponentId)),
    provenance: { repository: REPOSITORY, commit: COMMIT, componentPath: sourcePath },
  };
}

function runtimeAuthorization(
  overrides: Partial<BaselineAuthorization> = {},
): BaselineAuthorization {
  return { ...authorization("runtime:ecc-kiro", [".kiro"]), ...overrides };
}

function heldRuntime(): BaselineHeldComponent {
  return {
    componentId: "runtime:ecc-kiro",
    routeCode: "baseline.evidence-blocked",
    codes: ["malicious-code"],
    details: ["held runtime detail must not become projected content"],
  };
}

function caseSensitiveVolume(): boolean {
  const probe = join(sourceRoot, "case-probe");
  put("case-probe", "probe");
  const sensitive = !existsSync(probe.toUpperCase());
  rmSync(probe);
  return sensitive;
}

function fileSymlinksAvailable(): boolean {
  const probeRoot = mkdtempSync(join(tmpdir(), "aih-ecc-kiro-symlink-probe-"));
  const source = join(probeRoot, "source");
  const destination = join(probeRoot, "destination");
  try {
    writeFileSync(source, "probe");
    symlinkSync(source, destination, "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const FILE_SYMLINKS_AVAILABLE = fileSymlinksAvailable();

function request(
  components: readonly EccEffectiveSelectionComponent[],
  authorizations: readonly BaselineAuthorization[] = [runtimeAuthorization()],
  held: readonly BaselineHeldComponent[] = [],
) {
  return {
    sourceRoot,
    components,
    evidence: {
      authorizations: [
        ...components.map((component) => component.authorization),
        ...authorizations,
      ],
      held,
    },
  };
}

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "aih-ecc-kiro-target-"));
  writeSource();
});

afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("the verified-source Kiro projection", () => {
  it("projects only the selected exact Kiro skill and direct steering bytes", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const rules = selected("baseline:rules", "rules");
    const runtime = runtimeAuthorization();
    const result = resolveVerifiedKiroMaterialization(request([skill, rules], [runtime]));

    expect(result.components.map((component) => component.id)).toEqual([
      "baseline:rules",
      "skill:tdd-workflow",
    ]);
    const files = result.components.flatMap((component) => component.files);
    expect(files.map((file) => file.path)).toEqual([
      ".kiro/steering/security.md",
      ".kiro/steering/testing.md",
      ".kiro/skills/tdd-workflow/SKILL.md",
    ]);
    for (const file of files) {
      expect(file).toMatchObject({
        kind: "copy-file",
        contentAuthorization: runtime,
        contentSourcePath: file.path,
      });
    }
    const skillFile = files.find((file) => file.path.endsWith("/SKILL.md"));
    expect(Buffer.from(skillFile?.contents ?? "").toString("utf8")).toBe("# curated Kiro skill\n");
    expect(skill.authorization.treeSha256).not.toBe(runtime.treeSha256);
    expect(files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([
        ".kiro/agents/code-reviewer.md",
        ".kiro/hooks/on-save.json",
        ".kiro/scripts/format.sh",
        ".kiro/settings/mcp.json.example",
      ]),
    );
  });

  it("returns an empty projection for explicit deselection without runtime content", () => {
    rmSync(join(sourceRoot, ".kiro"), { recursive: true });
    expect(
      resolveVerifiedKiroMaterialization({
        sourceRoot,
        components: [],
        evidence: { authorizations: [], held: [] },
      }),
    ).toEqual({ components: [] });
  });

  it("is deterministic across selected-component permutations", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const rules = selected("baseline:rules", "rules");
    expect(resolveVerifiedKiroMaterialization(request([rules, skill]))).toEqual(
      resolveVerifiedKiroMaterialization(request([skill, rules])),
    );
  });

  it("projects the exact IDE Markdown and CLI JSON agent mappings under one Kiro target", () => {
    const agent = selected("agent:code-reviewer", "agents/code-reviewer.md");
    const result = resolveVerifiedKiroMaterialization(request([agent]));

    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    expect(result.components[0]?.files.map((file) => file.path)).toEqual([
      ".kiro/agents/code-reviewer.json",
      ".kiro/agents/code-reviewer.md",
    ]);
    const projected = Object.fromEntries(
      (result.components[0]?.files ?? []).map((file) => [
        file.path,
        {
          contents: Buffer.from(file.contents).toString("utf8"),
          authorization: file.contentAuthorization.componentId,
          source: file.contentSourcePath,
        },
      ]),
    );
    expect(projected).toEqual({
      ".kiro/agents/code-reviewer.json": {
        contents: SOURCE_TREE[".kiro/agents/code-reviewer.json"],
        authorization: "runtime:ecc-kiro",
        source: ".kiro/agents/code-reviewer.json",
      },
      ".kiro/agents/code-reviewer.md": {
        contents: SOURCE_TREE["agents/code-reviewer.md"],
        authorization: "agent:code-reviewer",
        source: "agents/code-reviewer.md",
      },
    });
  });

  it("refuses Kiro agents whose curated JSON identity or excluded runtime fields are unsafe", () => {
    const invalidConfigs = [
      '{"name":"other","mcpServers":{},"hooks":{}}\n',
      '{"name":"code-reviewer","mcpServers":{"github":{"command":"node"}},"hooks":{}}\n',
      '{"name":"code-reviewer","mcpServers":{},"hooks":{"stop":[{"command":"echo no"}]}}\n',
      '{"name":"code-reviewer","mcpServers":{},"hooks":{},"includeMcpJson":true}\n',
      '{"name":"code-reviewer","mcpServers":{},"hooks":{},"useLegacyMcpJson":true}\n',
      '{"name":"other","name":"code-reviewer","mcpServers":{},"hooks":{}}\n',
      '{"name":"code-reviewer","mcpServers":{},"hooks":{"stop":[{"command":"echo no"}]},"hooks":{}}\n',
      '{"name":"code-reviewer","mcpServers":{},"hooks":{},"includeMcpJson":true,"includeMcpJson":false}\n',
      '{"name":"code-reviewer","mcpServers":{},"hooks":{},"resources":{"file":"first","file":"second"}}\n',
      `{"name":"code-reviewer","mcpServers":{},"hooks":{},"resources":${"[".repeat(101)}null${"]".repeat(101)}}\n`,
      "not json\n",
    ];

    for (const contents of invalidConfigs) {
      put(".kiro/agents/code-reviewer.json", contents);
      const agent = selected("agent:code-reviewer", "agents/code-reviewer.md");
      expect(() => resolveVerifiedKiroMaterialization(request([agent])), contents).toThrow(
        /Kiro agent.*configuration|agent.*identity|MCP|hooks/i,
      );
    }
  });

  it("accepts no caller byte or prebuilt file surface", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const poisoned = {
      ...request([
        {
          ...skill,
          files: [{ path: ".kiro/skills/tdd-workflow/SKILL.md", contents: "poison" }],
        } as EccEffectiveSelectionComponent,
      ]),
      bytes: Buffer.from("poison"),
    };
    expect(() => resolveVerifiedKiroMaterialization(poisoned)).toThrow(
      /unknown or malformed request fields/i,
    );
  });

  it("rejects duplicate or malformed selected component identities", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    expect(() => resolveVerifiedKiroMaterialization(request([skill, skill]))).toThrow(
      /duplicate.*selected/i,
    );
    const rules = selected("baseline:rules", "rules");
    for (const component of [
      { ...skill, authorization: { ...skill.authorization, componentId: "skill:other" } },
      {
        ...skill,
        authorization: { ...skill.authorization, source: "foreign/ECC" },
      },
      {
        ...skill,
        authorization: { ...skill.authorization, pinnedSha: "d".repeat(40) },
      },
    ]) {
      expect(() => resolveVerifiedKiroMaterialization(request([component]))).toThrow(
        /selected.*authorization|repository|pin/i,
      );
    }
    for (const component of [
      {
        ...skill,
        provenance: { ...skill.provenance, componentPath: "skills/other" },
      },
      {
        ...rules,
        provenance: { ...rules.provenance, componentPath: "rules/not-pinned" },
      },
    ]) {
      expect(() => resolveVerifiedKiroMaterialization(request([component]))).toThrow(
        /provenance does not match/i,
      );
    }
  });

  it("accepts every exact catalog provenance path for baseline rules", () => {
    for (const path of ["rules", "rules/README.md", "rules/common"]) {
      const rules = selected("baseline:rules", path);
      expect(() => resolveVerifiedKiroMaterialization(request([rules]))).not.toThrow();
    }
  });

  it("joins every selected component to one exact current unheld authorization", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const current = request([skill]);
    const runtime = current.evidence.authorizations.find(
      (authorization) => authorization.componentId === "runtime:ecc-kiro",
    );
    if (runtime === undefined) throw new Error("test fixture is missing runtime evidence");
    const selectedHeld: BaselineHeldComponent = {
      componentId: skill.id,
      routeCode: "baseline.evidence-blocked",
      codes: ["malicious-code"],
      details: ["selected component held"],
    };
    const cases = [
      { ...current, evidence: { authorizations: [runtime], held: [] } },
      { ...current, evidence: { ...current.evidence, held: [selectedHeld] } },
      {
        ...current,
        evidence: {
          ...current.evidence,
          authorizations: [...current.evidence.authorizations, skill.authorization],
        },
      },
      {
        ...current,
        evidence: {
          ...current.evidence,
          authorizations: current.evidence.authorizations.map((authorization) =>
            authorization.componentId === skill.id
              ? { ...authorization, treeSha256: "d".repeat(64) }
              : authorization,
          ),
        },
      },
    ];
    for (const input of cases) {
      expect(() => resolveVerifiedKiroMaterialization(input)).toThrow(
        /selected component.*current|selected component authorization/i,
      );
    }
  });

  it("requires exactly one unheld runtime:ecc-kiro authorization", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const runtime = runtimeAuthorization();
    const cases = [
      ["missing", request([skill], [])],
      ["held", request([skill], [runtime], [heldRuntime()])],
      ["duplicate", request([skill], [runtime, { ...runtime }])],
    ] as const;
    for (const [label, input] of cases) {
      expect(() => resolveVerifiedKiroMaterialization(input), label).toThrow(/runtime:ecc-kiro/i);
    }
  });

  it("rejects every non-approved selected component without trimming", () => {
    const seed = selected("skill:tdd-workflow", "skills/tdd-workflow");
    for (const [id, path] of [
      ["command:review", "commands/review.md"],
      ["rule:security", "rules/security.md"],
      ["baseline:hooks", "hooks"],
      ["baseline:platform", ".claude-plugin"],
      ["mcp:github", "mcp-configs/mcp-servers.json"],
    ] as const) {
      const unsupported = {
        ...seed,
        id: id as EccComponentId,
        authorization: { ...seed.authorization, componentId: id },
        provenance: { ...seed.provenance, componentPath: path },
      };
      expect(() => resolveVerifiedKiroMaterialization(request([unsupported])), id).toThrow(
        /unsupported Kiro component/i,
      );
    }
  });

  it("rejects missing or partially representable selected content", () => {
    const missing = {
      id: "skill:missing" as EccComponentId,
      authorization: {
        ...runtimeAuthorization(),
        componentId: "skill:missing",
      },
      provenance: {
        repository: REPOSITORY,
        commit: COMMIT,
        componentPath: "skills/missing",
      },
    };
    expect(() => resolveVerifiedKiroMaterialization(request([missing]))).toThrow(
      /unsupported Kiro component|selected component tree/i,
    );
    const unmappedAgent = selected("agent:code-architect", "agents/code-architect.md");
    expect(() => resolveVerifiedKiroMaterialization(request([unmappedAgent]))).toThrow(
      /no pinned Kiro agent configuration/i,
    );
    put(".kiro/skills/tdd-workflow/nested/ignored.md", "# must not trim\n");
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    expect(() => resolveVerifiedKiroMaterialization(request([skill]))).toThrow(
      /direct.*skill|unsupported.*skill/i,
    );

    rmSync(join(sourceRoot, ".kiro", "skills", "tdd-workflow", "nested"), {
      recursive: true,
    });
    put(".kiro/steering/notes.txt", "must not trim\n");
    const rules = selected("baseline:rules", "rules");
    expect(() => resolveVerifiedKiroMaterialization(request([rules]))).toThrow(
      /direct.*steering|unsupported.*steering/i,
    );
  });

  it("rejects an empty current-shape Kiro skill instead of projecting a partial component", () => {
    rmSync(join(sourceRoot, ".kiro", "skills", "tdd-workflow", "SKILL.md"));
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    expect(() => resolveVerifiedKiroMaterialization(request([skill]))).toThrow(
      /Kiro skill.*SKILL\.md|empty.*Kiro skill/i,
    );
  });

  it.skipIf(!FILE_SYMLINKS_AVAILABLE)("rejects source-side file symlinks", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const runtime = runtimeAuthorization();
    symlinkSync(
      join(sourceRoot, "skills", "tdd-workflow", "SKILL.md"),
      join(sourceRoot, ".kiro", "skills", "tdd-workflow", "linked.md"),
    );
    expect(() => resolveVerifiedKiroMaterialization(request([skill], [runtime]))).toThrow(
      /symbolic link/i,
    );
  });

  it("rejects hostile selected provenance", () => {
    const hostile = {
      ...selected("skill:tdd-workflow", "skills/tdd-workflow"),
      provenance: {
        repository: REPOSITORY,
        commit: COMMIT,
        componentPath: "../outside",
      },
    };
    expect(() => resolveVerifiedKiroMaterialization(request([hostile]))).toThrow(
      /escape|source-relative|unsafe/i,
    );
  });

  it("revalidates selected and runtime tree hashes before projecting bytes", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    const runtime = runtimeAuthorization();
    put("skills/tdd-workflow/SKILL.md", "# changed after selected evidence\n");
    expect(() => resolveVerifiedKiroMaterialization(request([skill], [runtime]))).toThrow(
      /selected.*tree/i,
    );
    const currentSkill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    put(".kiro/skills/tdd-workflow/SKILL.md", "# changed after runtime evidence\n");
    expect(() => resolveVerifiedKiroMaterialization(request([currentSkill], [runtime]))).toThrow(
      /runtime.*tree/i,
    );
  });

  it("binds runtime evidence identity to every selected component", () => {
    const skill = selected("skill:tdd-workflow", "skills/tdd-workflow");
    for (const runtime of [
      runtimeAuthorization({ source: "other/ECC" }),
      runtimeAuthorization({ pinnedSha: "d".repeat(40) }),
      runtimeAuthorization({ evidenceSha256: "d".repeat(64) }),
      runtimeAuthorization({ tier: "org" }),
      runtimeAuthorization({ issuer: "other issuer" }),
    ]) {
      expect(() => resolveVerifiedKiroMaterialization(request([skill], [runtime]))).toThrow(
        /evidence binding|does not match/i,
      );
    }
  });

  it("rejects actual projected source collisions under destination folding", () => {
    if (!caseSensitiveVolume()) return;
    put(".kiro/steering/SECURITY.md", "# collision\n");
    const rules = selected("baseline:rules", "rules");
    expect(() => resolveVerifiedKiroMaterialization(request([rules]))).toThrow(/collision/i);
  });

  it("detects folded collisions without host filesystem assumptions", () => {
    expect(
      foldedKiroProjectionCollision([
        ".kiro/skills/tdd-workflow/README.md",
        ".kiro/skills/tdd-workflow/readme.md",
      ]),
    ).toEqual({
      first: ".kiro/skills/tdd-workflow/README.md",
      second: ".kiro/skills/tdd-workflow/readme.md",
    });
    expect(kiroAgentSemanticIdentity(".kiro/agents/Résumé.md")).toBe(
      kiroAgentSemanticIdentity(".kiro/agents/RÉSUMÉ.json"),
    );
  });
});
