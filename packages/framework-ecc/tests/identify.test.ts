import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identifyComponents } from "../src/identify.js";
import {
  descriptorOf,
  fixtureDescriptorBytes,
  fixtureDescriptorDocument,
  operationContext,
  PINNED_COMMIT,
} from "./context.js";

/** Component identification reads the vendor lock's components: Catalog's full descriptor. */
const catalogDescriptor = () => descriptorOf(fixtureDescriptorBytes());

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-identify-"));
  writeFileSync(
    join(root, "package.json"),
    '{"name":"fixture","devDependencies":{"typescript":"5"}}\n',
  );
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function vendorLockPaths(): Map<string, string[]> {
  const sections = fixtureDescriptorDocument().sections as {
    vendorLock: { components: { id: string; paths: string[] }[] };
  };
  return new Map(
    sections.vendorLock.components.map((component) => [component.id, component.paths]),
  );
}

describe("identifyComponents", () => {
  it("reports the stack's language packs and each host's components with pinned source paths", () => {
    const identified = identifyComponents(
      operationContext({
        root,
        targets: ["claude", "codex", "kiro", "windsurf"],
        descriptor: catalogDescriptor(),
      }),
    );
    expect(identified.upstream).toEqual({ repository: "affaan-m/ECC", commit: PINNED_COMMIT });
    expect(identified.languagePacks).toContain("typescript");
    const paths = vendorLockPaths();
    expect(identified.components.length).toBeGreaterThan(0);
    for (const component of identified.components) {
      expect(component.paths).toEqual(paths.get(component.id));
      expect(component.hosts).not.toContain("windsurf");
    }
    const kiro = identified.components.filter((component) => component.hosts.includes("kiro"));
    expect(kiro.map((component) => component.id)).toEqual(["runtime:ecc-kiro"]);
    expect(identified.components.some((component) => component.hosts.includes("claude"))).toBe(
      true,
    );
    expect(identified.components.some((component) => component.hosts.includes("codex"))).toBe(true);
  });

  it("reports no components for a host with no ECC install route", () => {
    const identified = identifyComponents(
      operationContext({ root, targets: ["windsurf"], descriptor: catalogDescriptor() }),
    );
    expect(identified.components).toEqual([]);
  });
});
