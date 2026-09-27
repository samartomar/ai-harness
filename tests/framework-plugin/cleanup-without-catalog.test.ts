import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";

vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/framework-plugin/load-framework-plugin.js")>();
  const { sourcePluginAccess } = await import("./source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkPluginV1: (id: Parameters<typeof actual.loadFrameworkPluginV1>[0]) =>
      actual.loadFrameworkPluginV1(id, { access: sourcePluginAccess(id) }),
  };
});

vi.mock("../../src/catalog-package/framework-descriptors.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/catalog-package/framework-descriptors.js")>();
  return {
    ...actual,
    loadFrameworkDescriptorBytesV1: async () => {
      throw new Error("Catalog package is not installed");
    },
  };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-cleanup-no-catalog-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function route(args: string[]) {
  const prior = process.exitCode;
  const output: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
  try {
    await buildProgram().parseAsync(["node", "aih", ...args, "--root", root]);
    return { exitCode: process.exitCode ?? 0, output: output.join("") };
  } finally {
    process.stdout.write = write;
    process.exitCode = prior;
  }
}

describe("Core cleanup without optional Catalog", () => {
  it.each([
    ["uninstall preview", ["uninstall"]],
    ["uninstall apply", ["uninstall", "--apply"]],
    ["prune preview", ["prune"]],
    ["prune apply", ["prune", "--apply"]],
  ])("%s succeeds in a temporary project without Catalog descriptors", async (_name, args) => {
    const before = existsSync(join(root, ".aih-config.json"));
    const result = await route(args);
    expect(result.exitCode, result.output).toBe(0);
    expect(existsSync(join(root, ".aih-config.json"))).toBe(before);
  });
});
