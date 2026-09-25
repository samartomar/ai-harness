import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitCoreProductDeclarationsV1 } from "../../src/internals/emit-core-product-declarations.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { defaultNativeMcpServers } from "../../src/mcp/default-native-runtime.js";
import { PLAYWRIGHT_MCP_PACKAGE_SPEC } from "../../src/mcp/servers.js";
import {
  aihPolicyControls,
  policyAuthoringHosts,
  policyAuthoringMcpCatalog,
} from "../../src/org-policy/catalog.js";
import {
  coreProductDeclarationsV1,
  coreProductDeclarationsV1Bytes,
} from "../../src/org-policy/core-product-declarations.js";
import { runtimeMcpCatalog, runtimeMcpIdentities } from "../../src/org-policy/runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = { version: "0.7.0", commit: COMMIT };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

function coreCheckout(
  manifest: Record<string, unknown> = { name: "@aihq/core", version: "0.7.0" },
) {
  const root = tempRoot("aih-core-declarations-checkout-");
  git(root, "init", "-q");
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  git(root, "add", "package.json");
  git(root, "commit", "-q", "-m", "fixture");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedDeep((value as Record<string, unknown>)[key])]),
    );
  return value;
}

describe("Core product declarations (the Catalog's core-product-declarations-v1.json)", () => {
  it("names the given Core source and derives every field from Core's own declarations", () => {
    const declarations = coreProductDeclarationsV1(SOURCE);
    expect(Object.keys(declarations)).toEqual([
      "format",
      "version",
      "source",
      "hosts",
      "mcp",
      "nonProjectableMcp",
      "unavailableMcp",
      "hooks",
      "hookRegistry",
    ]);
    expect(declarations.format).toBe("aih-catalog-core-product-declarations");
    expect(declarations.version).toBe(1);
    expect(declarations.source).toEqual({
      package: "@aihq/core",
      version: "0.7.0",
      repository: "samartomar/ai-harness",
      commit: COMMIT,
    });
    expect(declarations.hosts).toEqual(policyAuthoringHosts());

    const controls = aihPolicyControls();
    const mcpControls = controls.filter((control) => control.kind === "mcp");
    expect(declarations.mcp.map((entry) => entry.control)).toEqual(mcpControls);
    const catalog = policyAuthoringMcpCatalog();
    for (const entry of declarations.mcp) {
      expect(entry.server).toEqual(catalog[entry.id]);
      expect(entry.description).toBe(catalog[entry.id]?.description);
    }
    expect(declarations.nonProjectableMcp.map((entry) => entry.id)).toEqual(
      Object.entries(catalog)
        .filter(([, server]) => server.type !== "stdio")
        .map(([id]) => id),
    );
    expect(declarations.unavailableMcp.map((entry) => entry.configuredIdentity)).toEqual([
      PLAYWRIGHT_MCP_PACKAGE_SPEC,
    ]);

    expect(declarations.hooks.map((hook) => hook.control)).toEqual(
      controls.filter((control) => control.kind === "hook"),
    );
    expect(Object.keys(declarations.hookRegistry)).toEqual([
      "entries",
      "registrations",
      "overlaps",
      "spawnProjection",
    ]);
    for (const hook of declarations.hooks)
      expect(declarations.hookRegistry.entries.map((entry) => entry.id)).toContain(hook.id);
    expect(declarations.hookRegistry.entries.every((entry) => entry.owner === "aih")).toBe(true);
  });

  it("writes canonical bytes: fixed envelope order, sorted record keys, two-space JSON, one newline", () => {
    const bytes = coreProductDeclarationsV1Bytes(SOURCE);
    const text = Buffer.from(bytes).toString("utf8");
    const declarations = coreProductDeclarationsV1(SOURCE);
    expect(JSON.parse(text)).toEqual(declarations);
    const expected = {
      format: declarations.format,
      version: declarations.version,
      source: declarations.source,
      hosts: sortedDeep(declarations.hosts),
      mcp: sortedDeep(declarations.mcp),
      nonProjectableMcp: sortedDeep(declarations.nonProjectableMcp),
      unavailableMcp: sortedDeep(declarations.unavailableMcp),
      hooks: sortedDeep(declarations.hooks),
      hookRegistry: {
        entries: sortedDeep(declarations.hookRegistry.entries),
        registrations: sortedDeep(declarations.hookRegistry.registrations),
        overlaps: sortedDeep(declarations.hookRegistry.overlaps),
        spawnProjection: sortedDeep(declarations.hookRegistry.spawnProjection),
      },
    };
    expect(text).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(Buffer.from(coreProductDeclarationsV1Bytes(SOURCE)).equals(Buffer.from(bytes))).toBe(
      true,
    );
  });

  it.each([
    [{ version: "0.7", commit: COMMIT }],
    [{ version: "v0.7.0", commit: COMMIT }],
    [{ version: "0.7.0-rc.1", commit: COMMIT }],
    [{ version: "0.7.0", commit: COMMIT.slice(0, 12) }],
    [{ version: "0.7.0", commit: COMMIT.toUpperCase() }],
  ])("refuses a source that is not an exact release version and full commit: %j", (source) => {
    expect(() => coreProductDeclarationsV1(source)).toThrow(/Core product declarations/u);
  });
});

describe("emit-core-product-declarations", () => {
  it("names the checkout's package version and HEAD and writes the canonical bytes once", () => {
    const { root, head } = coreCheckout();
    const output = join(
      tempRoot("aih-core-declarations-out-"),
      "core-product-declarations-v1.json",
    );
    const result = emitCoreProductDeclarationsV1({ checkout: root, output });
    const expected = coreProductDeclarationsV1Bytes({ version: "0.7.0", commit: head });
    const written = readFileSync(output);
    expect(written.equals(Buffer.from(expected))).toBe(true);
    expect(result).toEqual({
      output,
      source: { version: "0.7.0", commit: head },
      sha256: createHash("sha256").update(written).digest("hex"),
    });
  });

  it("refuses a dirty checkout and writes nothing", () => {
    const { root } = coreCheckout();
    writeFileSync(join(root, "untracked.txt"), "dirty\n");
    const output = join(tempRoot("aih-core-declarations-out-"), "out.json");
    expect(() => emitCoreProductDeclarationsV1({ checkout: root, output })).toThrow(
      /checkout must be clean/u,
    );
    expect(existsSync(output)).toBe(false);
  });

  it("refuses to replace an existing output", () => {
    const { root } = coreCheckout();
    const output = join(tempRoot("aih-core-declarations-out-"), "out.json");
    writeFileSync(output, "kept\n");
    expect(() => emitCoreProductDeclarationsV1({ checkout: root, output })).toThrow(/EEXIST/u);
    expect(readFileSync(output, "utf8")).toBe("kept\n");
  });

  it.each([
    [{ name: "@aihq/scan", version: "0.7.0" }],
    [{ name: "@aihq/core", version: "0.7" }],
    [{ name: "@aihq/core" }],
  ])("refuses a checkout whose package is not an exact Core release: %j", (manifest) => {
    const { root } = coreCheckout(manifest);
    const output = join(tempRoot("aih-core-declarations-out-"), "out.json");
    expect(() => emitCoreProductDeclarationsV1({ checkout: root, output })).toThrow(
      /Core product declarations/u,
    );
    expect(existsSync(output)).toBe(false);
  });
});

/**
 * The integrity check the release needs (AC1 step 11). A Workbench selection of an
 * AIH MCP control carries the subject the Catalog declares; Core's runtime identity
 * check (effective.ts `runtime-mcp-identity-mismatch`) compares it with the subject
 * of the server Core would actually project for the project. This is a truthfulness
 * check on the declaration, never a finding gate.
 */
describe("Catalog MCP subjects equal Core's runtime identity subjects", () => {
  function projectContext(): PlanContext {
    const root = tempRoot("aih-core-declarations-project-");
    const run = fakeRunner(() => ({ code: 1, stderr: "no process in this fixture" }));
    return {
      root,
      contextDir: "ai-coding",
      posture: "enterprise",
      apply: false,
      verify: false,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  /**
   * Replaced at run time by root-aware authenticated launchers (`runtimeMcpCatalog`, since
   * #1016). Their runtime subjects name this machine's executable and paths, so no portable
   * declaration can equal them: a Workbench selection of one of these ids is reported
   * `runtime-mcp-identity-mismatch` and does not become effective. Surfaced for an owner
   * decision (CR1 report); this list may only shrink.
   */
  const ROOT_AWARE_RUNTIME_MCP_IDS = ["code-review-graph", "codebase-memory-mcp", "serena"];

  function divergence() {
    const ctx = projectContext();
    const declarations = coreProductDeclarationsV1(SOURCE);
    const identities = runtimeMcpIdentities(runtimeMcpCatalog(ctx));
    return {
      declarations,
      identities,
      native: Object.keys(defaultNativeMcpServers(ctx)),
      divergent: declarations.mcp
        .filter((entry) => {
          const source = entry.control.source;
          return source.type !== "mcp" || identities[entry.id]?.subject !== source.subject;
        })
        .map((entry) => entry.id),
    };
  }

  it("declares the runtime subject for every MCP control the runtime projects as declared", () => {
    const { declarations, identities } = divergence();
    const asDeclared = declarations.mcp.filter(
      (entry) => !ROOT_AWARE_RUNTIME_MCP_IDS.includes(entry.id),
    );
    expect(asDeclared.map((entry) => entry.id)).toEqual(["sequential-thinking"]);
    for (const entry of asDeclared) {
      expect(entry.control.source).toEqual({
        type: "mcp",
        server: entry.id,
        subject: identities[entry.id]?.subject,
      });
      expect(identities[entry.id]?.projectable).toBe(true);
    }
    for (const entry of declarations.nonProjectableMcp)
      expect(identities[entry.id]?.projectable).toBe(false);
  });

  it("differs from the runtime subject exactly where the runtime substitutes a root-aware launcher", () => {
    const { declarations, divergent, native } = divergence();
    expect(divergent).toEqual(ROOT_AWARE_RUNTIME_MCP_IDS);
    expect(declarations.mcp.map((entry) => entry.id).filter((id) => native.includes(id))).toEqual(
      ROOT_AWARE_RUNTIME_MCP_IDS,
    );
  });
});
