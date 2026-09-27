import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identifyComponents } from "../src/identify.js";
import {
  descriptorOf,
  fixtureDescriptorBytes,
  operationContext,
  PINNED_COMMIT,
} from "./context.js";

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

describe("identifyComponents", () => {
  it("reports pinned language packs without offering ECC installation components", () => {
    const identified = identifyComponents(
      operationContext({
        root,
        targets: ["claude", "codex", "kiro", "windsurf"],
        descriptor: catalogDescriptor(),
      }),
    );
    expect(identified.upstream).toEqual({ repository: "affaan-m/ECC", commit: PINNED_COMMIT });
    expect(identified.languagePacks).toContain("typescript");
    expect(identified.components).toEqual([]);
  });

  it("keeps language pack reporting independent of the selected host", () => {
    const identified = identifyComponents(
      operationContext({ root, targets: ["windsurf"], descriptor: catalogDescriptor() }),
    );
    expect(identified.components).toEqual([]);
    expect(identified.languagePacks).toContain("typescript");
  });
});
