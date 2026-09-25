import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D79: the installed Catalog's authority for a carried pin is the DECLARED definition
 * (`componentDefinitions`), not the component list of the `vendorLock` evidence lock. The
 * descriptors here are synthetic so the two sections can disagree the way K1's do while
 * every declared path still exists in the fixture checkout.
 */
const PIN = "5064474d4d762dc9640234a41617cccb79185cec";
const EARLIER_PIN = "5caf398a91599029a176ca6d806409b00d1052c4";
const DECLARED_INSTALLER = [
  "package.json",
  "scripts/lib/install/plan.js",
  "scripts/lib/atomic-write.js",
];
const EVIDENCE_INSTALLER = ["package.json", "scripts/lib/install/plan.js"];

interface SyntheticAsset {
  readonly id: string;
  readonly kind: string;
  readonly source: { repository: string; commit: string; path: string };
  readonly sourcePaths: readonly string[];
}

function asset(id: string, kind: string, sourcePaths: readonly string[]): SyntheticAsset {
  return {
    id,
    kind,
    source: { repository: "affaan-m/ECC", commit: PIN, path: sourcePaths[0] as string },
    sourcePaths,
  };
}

function descriptor(componentDefinitions: unknown) {
  return {
    format: "aih-catalog-framework-descriptor" as const,
    version: 1 as const,
    frameworkId: "ecc" as const,
    sections: {
      componentDefinitions,
      mcpInventory: { mcpServers: { github: {}, nexus: {} } },
      aihOwnedMcpExclusions: ["github"],
      // The sealed evidence lock for the EARLIER definition: a shorter installer closure.
      vendorLock: {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: PIN,
        components: [
          { id: "runtime:ecc-installer", paths: EVIDENCE_INSTALLER },
          { id: "skill:tdd", paths: ["skills/tdd"] },
          { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
        ],
      },
    },
  };
}

const declaration = (assets: readonly SyntheticAsset[], commit = PIN) => ({
  version: 1,
  framework: { id: "ecc", repository: "affaan-m/ECC", commit, assets },
});

const DECLARED_ASSETS = [
  asset("runtime:ecc-installer", "runtime", DECLARED_INSTALLER),
  asset("skill:tdd", "skill", ["skills/tdd/SKILL.md", "skills/tdd"]),
  asset("mcp:github", "mcp", [".mcp.json", "mcp-configs/mcp-servers.json"]),
  asset("mcp:nexus", "mcp", ["mcp-configs/mcp-servers.json"]),
];

let currentDescriptor = descriptor(declaration(DECLARED_ASSETS));

vi.mock("../../src/catalog-package/framework-descriptors.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/catalog-package/framework-descriptors.js")>();
  return {
    ...actual,
    loadFrameworkDescriptorV1: (
      id: Parameters<typeof actual.loadFrameworkDescriptorV1>[0],
      access?: Parameters<typeof actual.loadFrameworkDescriptorV1>[1],
    ) =>
      id === "ecc"
        ? structuredClone(currentDescriptor)
        : actual.loadFrameworkDescriptorV1(id, access),
  };
});

import {
  baselineCatalogById,
  DeclaredFrameworkCatalogRefusalError,
  declaredFrameworkCatalogV1,
} from "../../src/baseline-evidence/catalogs.js";
import { resolveScannerDefinitionV1 } from "../../src/baseline-evidence/scanner-definition.js";

let root: string;
let source: string;

function write(relative: string): void {
  const path = join(source, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, relative.endsWith("SKILL.md") ? "---\nname: tdd\n---\n" : "{}\n");
}

function definitionFile(value: unknown, name = "definition.json"): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function resolve(value: unknown, head = PIN) {
  return resolveScannerDefinitionV1({
    sourceRoot: source,
    catalogId: "ecc",
    definitionPath: definitionFile(value),
    head,
  });
}

beforeEach(() => {
  currentDescriptor = descriptor(declaration(DECLARED_ASSETS));
  root = mkdtempSync(join(tmpdir(), "aih-scanner-declared-"));
  source = join(root, "source");
  mkdirSync(source);
  write("package.json");
  write("scripts/lib/install/plan.js");
  write("scripts/lib/atomic-write.js");
  write("skills/tdd/SKILL.md");
  write(".mcp.json");
  write("mcp-configs/mcp-servers.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("definition resolution against the declared Catalog definition (D79)", () => {
  it("accepts the declared definition while the evidence lock carries the earlier one", () => {
    const declared = declaredFrameworkCatalogV1(
      "ecc",
      currentDescriptor.sections as Readonly<Record<string, unknown>>,
      { sourceRoot: source },
    );
    expect(declared.components.map((component) => component.id)).toEqual([
      "runtime:ecc-installer",
      "skill:tdd",
      "mcp:github",
    ]);
    expect(
      declared.components.find((component) => component.id === "runtime:ecc-installer")?.paths,
    ).toEqual(DECLARED_INSTALLER);

    const resolved = resolve(declared);
    expect(resolved.route).toBe("installed");
    expect(resolved.catalog).toEqual(declared);
  });

  it("reads the declared definition at the checkout, so a container's skill material counts", () => {
    // Only the checkout can show that `.agents` holds skill files; the resolver must pass
    // it, or the carried definition would silently disagree with the declared one.
    currentDescriptor = descriptor(
      declaration([...DECLARED_ASSETS, asset("module:container", "module", [".agents"])]),
    );
    mkdirSync(join(source, ".agents/skills/extra"), { recursive: true });
    writeFileSync(join(source, ".agents/skills/extra/SKILL.md"), "---\nname: extra\n---\n");

    const declared = declaredFrameworkCatalogV1(
      "ecc",
      currentDescriptor.sections as Readonly<Record<string, unknown>>,
      { sourceRoot: source },
    );
    expect(
      declared.components.find((component) => component.id === "module:container"),
    ).toMatchObject({ skillContent: true });
    expect(resolve(declared).route).toBe("installed");
  });

  it("refuses the earlier evidence lock's definition while the declared one is carried", () => {
    const earlier = {
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: PIN,
      components: [
        { id: "runtime:ecc-installer", paths: EVIDENCE_INSTALLER },
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
      ],
    };
    expect(() => resolve(earlier)).toThrow(
      /installed Catalog carries ecc@5064474d4d762dc9640234a41617cccb79185cec \(sha256:[0-9a-f]{64}\); the definition differs \(sha256:[0-9a-f]{64}\)/,
    );
  });

  it("refuses a definition declared nowhere", () => {
    const third = {
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: PIN,
      components: [
        { id: "runtime:ecc-installer", paths: ["package.json"] },
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
      ],
    };
    expect(() => resolve(third)).toThrow(/the definition differs/);
  });

  it("keeps today's route when the two sections agree", () => {
    currentDescriptor = descriptor(
      declaration([
        asset("runtime:ecc-installer", "runtime", EVIDENCE_INSTALLER),
        asset("skill:tdd", "skill", ["skills/tdd/SKILL.md", "skills/tdd"]),
        asset("mcp:github", "mcp", [".mcp.json", "mcp-configs/mcp-servers.json"]),
      ]),
    );
    const agreed = resolve({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: PIN,
      components: [
        { id: "runtime:ecc-installer", paths: EVIDENCE_INSTALLER },
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
      ],
    });
    expect(agreed.route).toBe("installed");
    expect(agreed.catalog.pinnedSha).toBe(PIN);

    expect(() =>
      resolve({
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: PIN,
        components: [
          { id: "runtime:ecc-installer", paths: DECLARED_INSTALLER },
          { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        ],
      }),
    ).toThrow(/the definition differs/);
  });

  it.each([
    ["a missing section", { vendorLock: { components: [] } }, "missing-definition"],
    [
      "a malformed asset",
      declaration([asset("runtime:ecc-installer", "runtime", [])]),
      "malformed-definition",
    ],
  ])(
    "refuses %s with a typed error instead of the evidence lock's component list",
    (_label, componentDefinitions, reason) => {
      currentDescriptor = descriptor(componentDefinitions);
      const definition = declaredFrameworkCatalogV1(
        "ecc",
        descriptor(declaration(DECLARED_ASSETS)).sections as Readonly<Record<string, unknown>>,
        { sourceRoot: source },
      );
      let refusal: unknown;
      try {
        resolve(definition);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DeclaredFrameworkCatalogRefusalError);
      expect(refusal).toMatchObject({ code: "AIH_CATALOG_DECLARED_DEFINITION", reason });
      // The refusal is the declared section's, never the earlier evidence lock's verdict.
      expect((refusal as Error).message).not.toMatch(/the definition differs/);
    },
  );

  it("refuses a pin the declared definition does not carry, by both identities", () => {
    let refusal: unknown;
    try {
      baselineCatalogById("ecc", EARLIER_PIN, { sourceRoot: source });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "AIH_TRUST" });
    expect((refusal as Error).message).toContain(PIN);
    expect((refusal as Error).message).toContain(EARLIER_PIN);
  });
});
