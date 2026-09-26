import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  baselineCatalogById,
  DeclaredFrameworkCatalogRefusalError,
  declaredFrameworkCatalogV1,
} from "../../src/baseline-evidence/catalogs.js";
import { loadFrameworkDescriptorV1 } from "../../src/catalog-package/framework-descriptors.js";
import { AihError } from "../../src/errors.js";
import { BASELINE_SOURCES } from "../../src/internals/baseline-sources.js";
import { hermeticGitEnv } from "../git-fixture-env.js";

function registryPin(owner: string, repo: string): string {
  const source = BASELINE_SOURCES.flatMap((baseline) => [...baseline.sources]).find(
    (candidate) => candidate.owner === owner && candidate.repo === repo,
  );
  if (!source) throw new Error(`missing registry source ${owner}/${repo}`);
  return source.pinnedSha;
}

describe("production baseline catalogs", () => {
  it("binds ECC components to the existing registry pin and locked common baseline", () => {
    const eccProfiles = loadFrameworkDescriptorV1("ecc").sections.profileGraph as {
      profiles: { full: { modules: string[] } };
    };
    const catalog = baselineCatalogById("ecc");
    expect(catalog.pinnedSha).toBe(registryPin("affaan-m", "ECC"));
    const ids = catalog.components.map((component) => component.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "runtime:ecc-installer",
        "runtime:ecc-kiro",
        "module:rules-core",
        "module:agents-core",
        "module:commands-core",
        "module:hooks-runtime",
        "module:platform-configs",
        "module:workflow-quality",
        "module:framework-language",
        "module:security",
        "module:orchestration",
        "module:document-processing",
        "module:nasiko-control-plane",
        "baseline:rules",
        "baseline:agents",
        "lang:typescript",
        "framework:react",
        "capability:documents",
        "skill:tdd-workflow",
        "skill:verification-loop",
        "skill:strategic-compact",
        "skill:coding-standards",
        "agent:code-reviewer",
        "agent:code-architect",
        "agent:architect",
        "agent:planner",
        "agent:tdd-guide",
        "agent:build-error-resolver",
        "agent:refactor-cleaner",
        "agent:code-simplifier",
        "agent:silent-failure-hunter",
        "agent:pr-test-analyzer",
        "agent:doc-updater",
        "agent:docs-lookup",
        "agent:code-explorer",
        "agent:security-reviewer",
        "agent:type-design-analyzer",
        "agent:performance-optimizer",
      ]),
    );
    expect(ids.filter((id) => id.startsWith("module:"))).toEqual(
      eccProfiles.profiles.full.modules.map((id) => `module:${id}`),
    );
    expect(ids.filter((id) => id.startsWith("module:"))).toHaveLength(26);
    expect(ids.some((id) => id.startsWith("module:docs-"))).toBe(false);
    expect(
      catalog.components.some((component) =>
        component.paths.some((path) => path.startsWith("docs/")),
      ),
    ).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    // The evidence catalog reads `vendorLock`, whose receipts and paths decide `skillContent`.
    for (const id of [
      "runtime:ecc-kiro",
      "module:agents-core",
      "module:platform-configs",
      "skill:tdd-workflow",
    ]) {
      expect(catalog.components.find((component) => component.id === id)).toMatchObject({
        skillContent: true,
      });
    }
    expect(
      catalog.components.find((component) => component.id === "runtime:ecc-installer"),
    ).not.toHaveProperty("skillContent");
    expect(
      catalog.components.find((component) => component.id === "runtime:ecc-installer")?.paths,
    ).toEqual(
      expect.arrayContaining([
        "scripts/lib/invocation-environment.js",
        "scripts/lib/opencode-paths.js",
      ]),
    );
    expect(
      catalog.components.find((component) => component.id === "baseline:agents")?.paths,
    ).toEqual([".agents/plugins/marketplace.json", "AGENTS.md"]);
    expect(catalog.components.find((component) => component.id === "agent:planner")?.paths).toEqual(
      ["agents/planner.md"],
    );
    expect(
      catalog.components.find((component) => component.id === "framework:react")?.paths,
    ).not.toContain("skills/frontend-slides");
  });

  it("binds Superpowers runtime and installable skills to its registry pin", () => {
    const catalog = baselineCatalogById("superpowers");
    expect(catalog.pinnedSha).toBe(registryPin("obra", "Superpowers"));
    expect(catalog.components.map((component) => component.id)).toEqual([
      "runtime:superpowers-plugin",
      "skill:brainstorming",
      "skill:diagnosing-superpowers",
      "skill:dispatching-parallel-agents",
      "skill:executing-plans",
      "skill:finishing-a-development-branch",
      "skill:receiving-code-review",
      "skill:requesting-code-review",
      "skill:subagent-driven-development",
      "skill:systematic-debugging",
      "skill:test-driven-development",
      "skill:using-git-worktrees",
      "skill:using-superpowers",
      "skill:verification-before-completion",
      "skill:writing-plans",
      "skill:writing-skills",
    ]);
  });

  it("binds the layout only to the pin the installed Catalog carries, refusing others by both identities", () => {
    const carried = baselineCatalogById("ecc").pinnedSha;
    expect(baselineCatalogById("ecc", carried).pinnedSha).toBe(carried);
    const other = "e".repeat(40);
    let refusal: unknown;
    try {
      baselineCatalogById("ecc", other);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AihError);
    expect(refusal).toMatchObject({ code: "AIH_TRUST" });
    expect((refusal as AihError).message).toContain(carried);
    expect((refusal as AihError).message).toContain(other);
    expect(() => baselineCatalogById("unknown")).toThrow(/unknown/i);
  });
});

/**
 * A real git checkout at a pin. The declared definition decides `skillContent` from the
 * PINNED COMMIT's tree in this checkout's object store — never from the working tree, so an
 * untracked or modified file cannot change the carried definition.
 */
const declaredCheckout = mkdtempSync(join(tmpdir(), "aih-declared-catalog-"));

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(),
  });
}

function commitFixture(root: string, files: readonly string[]): string {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Declared Catalog Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  for (const relative of files) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "---\nname: fixture\n---\n");
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "pin"]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

/** The pin the fixture checkout is at; every declared descriptor below is bound to it. */
const DECLARED_PIN = commitFixture(declaredCheckout, [
  "package.json",
  "scripts/lib/install/plan.js",
  ".kiro/SKILL.md",
  ".agents/skills/demo/SKILL.md",
  ".claude-plugin/skills/demo/SKILL.md",
  ".cursor/skills/demo/SKILL.md",
]);

afterAll(() => {
  rmSync(declaredCheckout, { recursive: true, force: true });
});

/**
 * K1's real declared asset list, rebound to the fixture pin so the fixture checkout can
 * carry its material. Paths, aliases and the MCP option set are K1's own.
 */
function k1DeclaredSectionsAtFixturePin(): Readonly<Record<string, unknown>> {
  const sections = structuredClone(loadFrameworkDescriptorV1("ecc").sections) as Record<
    string,
    unknown
  >;
  const definitions = sections.componentDefinitions as {
    framework: { commit: string; assets: { source?: { commit?: string } }[] };
  };
  definitions.framework.commit = DECLARED_PIN;
  for (const asset of definitions.framework.assets)
    if (asset.source !== undefined) asset.source.commit = DECLARED_PIN;
  return sections;
}

const syntheticAsset = (
  id: string,
  kind: string,
  sourcePaths: string[],
  path = sourcePaths[0] as string,
) => ({
  id,
  kind,
  source: { repository: "affaan-m/ECC", commit: DECLARED_PIN, path },
  sourcePaths,
});
const syntheticSections = (
  assets: readonly unknown[],
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  componentDefinitions: {
    version: "pinned-baseline/v1",
    framework: { id: "ecc", repository: "affaan-m/ECC", commit: DECLARED_PIN, assets },
  },
  ...extra,
});

/**
 * A hostile `componentDefinitions` section: one valid declaration with exactly the named
 * changes applied, so each refusal below is the declaration's own field, never the
 * requested-pin argument.
 */
function hostileDefinitions(
  section: Readonly<Record<string, unknown>> = {},
  framework: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    componentDefinitions: {
      version: "pinned-baseline/v1",
      framework: {
        id: "ecc",
        repository: "affaan-m/ECC",
        commit: DECLARED_PIN,
        assets: [syntheticAsset("x:y", "module", ["a"])],
        ...framework,
      },
      ...section,
    },
  };
}

describe("declared framework catalog (D79)", () => {
  it("reads the declared componentDefinitions, not an evidence lock's component list", () => {
    const catalog = declaredFrameworkCatalogV1("ecc", k1DeclaredSectionsAtFixturePin(), {
      sourceRoot: declaredCheckout,
    });
    const installer = catalog.components.find(
      (component) => component.id === "runtime:ecc-installer",
    );
    // The descriptor's declared definition carries EI1's D55 closure; `vendorLock` — the
    // component list of the sealed P' evidence lock — carries 17 paths without it.
    expect(installer?.paths).toHaveLength(18);
    expect(installer?.paths).toContain("scripts/lib/atomic-write.js");
    // The 31 source-locked inventory options are declared assets too, but not components.
    expect(catalog.components.some((component) => component.id === "mcp:nexus")).toBe(false);
    expect(catalog.components.some((component) => component.id === "mcp:github")).toBe(true);
    // Catalog's compiler adapter adds `rules` to `baseline:rules`; the definition is the rest.
    expect(
      catalog.components.find((component) => component.id === "baseline:rules")?.paths,
    ).toEqual(["rules/common", "rules/README.md"]);
  });

  it("decides skillContent from the pinned commit's tree, never from the working tree", () => {
    const sections = k1DeclaredSectionsAtFixturePin();
    const before = declaredFrameworkCatalogV1("ecc", sections, { sourceRoot: declaredCheckout });
    for (const id of [
      "runtime:ecc-kiro",
      "module:agents-core",
      "module:platform-configs",
      "baseline:platform",
    ]) {
      expect(before.components.find((component) => component.id === id)).toMatchObject({
        skillContent: true,
      });
    }
    expect(
      before.components.find((component) => component.id === "runtime:ecc-installer"),
    ).not.toHaveProperty("skillContent");

    // An untracked SKILL.md below a declared path changes nothing: the commit is what counts.
    const untracked = join(declaredCheckout, "scripts/lib/install/SKILL.md");
    writeFileSync(untracked, "---\nname: untracked\n---\n");
    try {
      const after = declaredFrameworkCatalogV1("ecc", sections, { sourceRoot: declaredCheckout });
      expect(after).toEqual(before);
      expect(
        after.components.find((component) => component.id === "runtime:ecc-installer"),
      ).not.toHaveProperty("skillContent");
    } finally {
      rmSync(untracked, { force: true });
    }

    // A modified working-tree file cannot take committed skill material away either.
    const committed = join(declaredCheckout, ".agents/skills/demo/SKILL.md");
    writeFileSync(committed, "not the committed bytes\n");
    try {
      const after = declaredFrameworkCatalogV1("ecc", sections, { sourceRoot: declaredCheckout });
      expect(after).toEqual(before);
    } finally {
      writeFileSync(committed, "---\nname: fixture\n---\n");
    }
  });

  it("refuses a declared catalog without a source root, with a typed error and no fallback", () => {
    let refusal: unknown;
    try {
      declaredFrameworkCatalogV1(
        "ecc",
        k1DeclaredSectionsAtFixturePin(),
        {} as unknown as { sourceRoot: string },
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DeclaredFrameworkCatalogRefusalError);
    expect(refusal).toMatchObject({
      code: "AIH_CATALOG_DECLARED_DEFINITION",
      reason: "source-root-required",
    });
  });

  it("refuses a checkout whose HEAD is not the declared pin", () => {
    const other = mkdtempSync(join(tmpdir(), "aih-declared-catalog-other-"));
    try {
      const otherPin = commitFixture(other, ["package.json"]);
      expect(otherPin).not.toBe(DECLARED_PIN);
      let refusal: unknown;
      try {
        declaredFrameworkCatalogV1(
          "ecc",
          syntheticSections([syntheticAsset("x:y", "module", ["package.json"])]),
          { sourceRoot: other },
        );
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DeclaredFrameworkCatalogRefusalError);
      expect(refusal).toMatchObject({
        code: "AIH_CATALOG_DECLARED_DEFINITION",
        reason: "checkout-not-at-pin",
      });
      expect((refusal as Error).message).toContain(DECLARED_PIN);
      expect((refusal as Error).message).toContain(otherPin);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("converts a declared section exactly, refusing rather than reading another section", () => {
    const section = syntheticSections(
      [
        syntheticAsset("runtime:installer", "runtime", ["package.json", "scripts/install.js"]),
        syntheticAsset("skill:demo", "skill", [
          ".agents/skills/demo",
          "skills/demo",
          "skills/demo/SKILL.md",
        ]),
        syntheticAsset("baseline:rules", "baseline", ["rules", "rules/common", "rules/README.md"]),
        syntheticAsset("module:container", "module", [".agents", "agents/one.md"]),
        syntheticAsset("mcp:github", "mcp", [".mcp.json", "mcp-configs/mcp-servers.json"]),
        syntheticAsset("mcp:nexus", "mcp", ["mcp-configs/mcp-servers.json"]),
      ],
      {
        mcpInventory: { mcpServers: { github: {}, nexus: {} } },
        aihOwnedMcpExclusions: ["github"],
        // Present and deliberately different: the conversion must not read it.
        vendorLock: {
          owner: "affaan-m",
          repo: "ECC",
          pinnedSha: DECLARED_PIN,
          components: [{ id: "runtime:installer", paths: ["package.json"] }],
        },
      },
    );
    const catalog = declaredFrameworkCatalogV1("ecc", section, { sourceRoot: declaredCheckout });
    expect(catalog).toEqual({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: DECLARED_PIN,
      components: [
        { id: "runtime:installer", paths: ["package.json", "scripts/install.js"] },
        { id: "skill:demo", paths: [".agents/skills/demo", "skills/demo"], skillContent: true },
        { id: "baseline:rules", paths: ["rules/common", "rules/README.md"] },
        { id: "module:container", paths: [".agents", "agents/one.md"], skillContent: true },
        { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
      ],
    });
  });

  it.each([
    [
      "a missing section",
      { vendorLock: { owner: "affaan-m", repo: "ECC", pinnedSha: DECLARED_PIN, components: [] } },
      "missing-definition",
    ],
    [
      "a wrong section version",
      hostileDefinitions({ version: "pinned-baseline/v2" }),
      "unsupported-version",
    ],
    [
      "an unknown field on the section",
      hostileDefinitions({ curatedBy: "hostile" }),
      "unknown-field",
    ],
    [
      "an unknown field on the framework",
      hostileDefinitions({}, { label: "hostile" }),
      "unknown-field",
    ],
    [
      "an unknown field on an asset",
      hostileDefinitions(
        {},
        { assets: [{ ...syntheticAsset("x:y", "module", ["a"]), label: "x" }] },
      ),
      "unknown-field",
    ],
    [
      "an unknown field on an asset source",
      hostileDefinitions(
        {},
        {
          assets: [
            {
              ...syntheticAsset("x:y", "module", ["a"]),
              source: {
                repository: "affaan-m/ECC",
                commit: DECLARED_PIN,
                path: "a",
                branch: "main",
              },
            },
          ],
        },
      ),
      "unknown-field",
    ],
    [
      "an unknown asset kind",
      hostileDefinitions({}, { assets: [syntheticAsset("x:y", "widget", ["a"])] }),
      "unknown-asset-kind",
    ],
    [
      "an asset without a source",
      hostileDefinitions({}, { assets: [{ id: "x:y", kind: "module", sourcePaths: ["a"] }] }),
      "missing-asset-source",
    ],
    [
      "an asset authored at another repository",
      hostileDefinitions(
        {},
        {
          assets: [
            {
              ...syntheticAsset("x:y", "module", ["a"]),
              source: { repository: "someone/else", commit: DECLARED_PIN, path: "a" },
            },
          ],
        },
      ),
      "asset-source-mismatch",
    ],
    [
      "an asset authored at another commit",
      hostileDefinitions(
        {},
        {
          assets: [
            {
              ...syntheticAsset("x:y", "module", ["a"]),
              source: { repository: "affaan-m/ECC", commit: "b".repeat(40), path: "a" },
            },
          ],
        },
      ),
      "asset-source-mismatch",
    ],
    ["another framework id", hostileDefinitions({}, { id: "superpowers" }), "malformed-definition"],
    [
      "a malformed asset",
      hostileDefinitions(
        {},
        { assets: [{ ...syntheticAsset("x:y", "module", ["a"]), sourcePaths: [] }] },
      ),
      "malformed-definition",
    ],
    [
      "a repository that is not owner/repo",
      hostileDefinitions({}, { repository: "ECC" }),
      "malformed-definition",
    ],
    [
      "an MCP inventory without its aih-owned exclusions",
      syntheticSections([syntheticAsset("x:y", "module", ["a"])], {
        mcpInventory: { mcpServers: { nexus: {} } },
      }),
      "missing-definition",
    ],
  ])("refuses %s with a typed error and no fallback", (_label, sections, reason) => {
    let refusal: unknown;
    try {
      declaredFrameworkCatalogV1("ecc", sections as Readonly<Record<string, unknown>>, {
        sourceRoot: declaredCheckout,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DeclaredFrameworkCatalogRefusalError);
    expect(refusal).toMatchObject({ code: "AIH_CATALOG_DECLARED_DEFINITION", reason });
  });
});
