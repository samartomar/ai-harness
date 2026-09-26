import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hermeticGitEnv } from "../git-fixture-env.js";

/**
 * D79: the installed Catalog's authority for a carried pin is the DECLARED definition
 * (`componentDefinitions`), not the component list of the `vendorLock` evidence lock. The
 * descriptors here are synthetic so the two sections can disagree the way K1's do while
 * every declared path still exists in the fixture checkout — a real git checkout, because
 * the declared `skillContent` decision reads the PINNED COMMIT's tree.
 */
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

/** The fixture checkout's own commit; every synthetic declaration is bound to it. */
let pin: string;

function asset(id: string, kind: string, sourcePaths: readonly string[]): SyntheticAsset {
  return {
    id,
    kind,
    source: { repository: "affaan-m/ECC", commit: pin, path: sourcePaths[0] as string },
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
        pinnedSha: pin,
        components: [
          { id: "runtime:ecc-installer", paths: EVIDENCE_INSTALLER },
          { id: "skill:tdd", paths: ["skills/tdd"] },
          { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
        ],
      },
    },
  };
}

const declaration = (assets: readonly SyntheticAsset[], commit = pin) => ({
  version: "pinned-baseline/v1",
  framework: { id: "ecc", repository: "affaan-m/ECC", commit, assets },
});

const declaredAssets = () => [
  asset("runtime:ecc-installer", "runtime", DECLARED_INSTALLER),
  asset("skill:tdd", "skill", ["skills/tdd/SKILL.md", "skills/tdd"]),
  asset("mcp:github", "mcp", [".mcp.json", "mcp-configs/mcp-servers.json"]),
  asset("mcp:nexus", "mcp", ["mcp-configs/mcp-servers.json"]),
];

let currentDescriptor: ReturnType<typeof descriptor>;

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

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: source,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(),
  });
}

/** Commit every file written so far and return the new pin. */
function commitSource(message = "pin"): string {
  git(["add", "-A"]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

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

function resolve(value: unknown, head = pin) {
  return resolveScannerDefinitionV1({
    sourceRoot: source,
    catalogId: "ecc",
    definitionPath: definitionFile(value),
    head,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-scanner-declared-"));
  source = join(root, "source");
  mkdirSync(source);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Declared Definition Test"]);
  git(["config", "commit.gpgsign", "false"]);
  write("package.json");
  write("scripts/lib/install/plan.js");
  write("scripts/lib/atomic-write.js");
  write("skills/tdd/SKILL.md");
  write(".mcp.json");
  write("mcp-configs/mcp-servers.json");
  pin = commitSource();
  currentDescriptor = descriptor(declaration(declaredAssets()));
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

  it("reads the declared definition at the pinned commit's tree, so a container's skill material counts", () => {
    // Only the committed tree can show that `.agents` holds skill files; the resolver must
    // read it at the pin, or the carried definition would silently disagree with the
    // declared one.
    write(".agents/skills/extra/SKILL.md");
    pin = commitSource("container");
    currentDescriptor = descriptor(
      declaration([...declaredAssets(), asset("module:container", "module", [".agents"])]),
    );

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
      pinnedSha: pin,
      components: [
        { id: "runtime:ecc-installer", paths: EVIDENCE_INSTALLER },
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
      ],
    };
    expect(() => resolve(earlier)).toThrow(
      /installed Catalog carries ecc@[0-9a-f]{40} \(sha256:[0-9a-f]{64}\); the definition differs \(sha256:[0-9a-f]{64}\)/,
    );
  });

  it("refuses a definition declared nowhere", () => {
    const third = {
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: pin,
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
      pinnedSha: pin,
      components: [
        { id: "runtime:ecc-installer", paths: EVIDENCE_INSTALLER },
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        { id: "mcp:github", paths: [".mcp.json", "mcp-configs/mcp-servers.json"] },
      ],
    });
    expect(agreed.route).toBe("installed");
    expect(agreed.catalog.pinnedSha).toBe(pin);

    expect(() =>
      resolve({
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: pin,
        components: [
          { id: "runtime:ecc-installer", paths: DECLARED_INSTALLER },
          { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        ],
      }),
    ).toThrow(/the definition differs/);
  });

  it.each([
    ["a missing section", undefined, "missing-definition"],
    [
      "a malformed asset",
      declaration([
        { ...asset("runtime:ecc-installer", "runtime", ["package.json"]), sourcePaths: [] },
      ]),
      "malformed-definition",
    ],
  ])(
    "refuses %s with a typed error instead of the evidence lock's component list",
    (_label, componentDefinitions, reason) => {
      currentDescriptor = descriptor(componentDefinitions);
      const definition = declaredFrameworkCatalogV1(
        "ecc",
        descriptor(declaration(declaredAssets())).sections as Readonly<Record<string, unknown>>,
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

  it("keeps today's route for a pin the declared definition does not carry", () => {
    // The checkout is at the fixture pin. A definition at another pin is uncarried, so the
    // resolver never asks the checkout to be at the declared pin: it keeps the definition.
    const elsewhere = {
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: EARLIER_PIN,
      components: [{ id: "runtime:ecc-installer", paths: ["package.json"] }],
    };
    const resolved = resolve(elsewhere, EARLIER_PIN);
    expect(resolved.route).toBe("definition");
    expect(resolved.catalog).toEqual(elsewhere);
  });

  it("refuses a pin the installed Catalog does not carry, by both identities", () => {
    // `baselineCatalogById` is the evidence-lock facade, so this reads the installed
    // descriptor (not the synthetic one this file mocks for the definition route).
    const carried = baselineCatalogById("ecc").pinnedSha;
    let refusal: unknown;
    try {
      baselineCatalogById("ecc", EARLIER_PIN);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "AIH_TRUST" });
    expect((refusal as Error).message).toContain(carried);
    expect((refusal as Error).message).toContain(EARLIER_PIN);
  });
});
