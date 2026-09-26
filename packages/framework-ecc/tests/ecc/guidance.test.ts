import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../../../src/program.js";
import { eccGuidance, eccStatus } from "../../src/guidance.js";

vi.mock("../../../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/framework-plugin/load-framework-plugin.js")
    >();
  const { sourcePluginAccess } = await import(
    "../../../../tests/framework-plugin/source-plugin-mocks.js"
  );
  return {
    ...actual,
    loadFrameworkPluginV1: (
      id: Parameters<typeof actual.loadFrameworkPluginV1>[0],
      options: Parameters<typeof actual.loadFrameworkPluginV1>[1] = {},
    ) => actual.loadFrameworkPluginV1(id, { ...options, access: sourcePluginAccess(id) }),
  };
});
vi.mock("../../../../src/catalog-package/framework-descriptors.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/catalog-package/framework-descriptors.js")
    >();
  const { eccDescriptorLoad } = await import(
    "../../../../tests/framework-plugin/source-plugin-mocks.js"
  );
  return {
    ...actual,
    loadFrameworkDescriptorBytesV1: async (
      id: Parameters<typeof actual.loadFrameworkDescriptorBytesV1>[0],
    ) => (id === "ecc" ? eccDescriptorLoad() : actual.loadFrameworkDescriptorBytesV1(id)),
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ECC basic guidance", () => {
  it("gives the reviewed exact-source commands and labels marketplace routes mutable", () => {
    const text = eccGuidance(["claude", "codex"], "linux");
    expect(text).toContain("git clone https://github.com/affaan-m/ECC.git");
    expect(text).toContain("git -C ECC checkout 5064474d4d762dc9640234a41617cccb79185cec");
    expect(text).toContain("./install.sh --profile minimal --target claude");
    expect(text).toContain("./install.sh --profile minimal --target codex");
    expect(text).toContain("node scripts/uninstall.js --target claude --dry-run");
    expect(text).toContain("bash .kiro/install.sh <project>");
    expect(text).toMatch(/marketplace.*mutable.*do not prove the reviewed pin/is);
    expect(text).toMatch(/MCP.*no exact reviewed command/is);
  });

  it("reports file presence without reading secret values or writing files", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-ecc-guidance-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    mkdirSync(join(home, ".claude", "ecc"), { recursive: true });
    const receipt = join(root, ".aih", "ecc", "materialization-v1.json");
    writeFileSync(receipt, "SECRET_SENTINEL");
    writeFileSync(join(home, ".claude", "ecc", "install-state.json"), "SECRET_SENTINEL");
    const before = readFileSync(receipt, "utf8");
    const text = eccStatus(root, home);
    expect(text).toContain("materialization-v1.json");
    expect(text).toContain("install-state.json");
    expect(text).not.toContain("SECRET_SENTINEL");
    expect(text).toContain("Not inspected:");
    expect(readFileSync(receipt, "utf8")).toBe(before);
  });

  it.each([
    ["--apply"],
    ["--lifecycle", "install"],
    ["--lifecycle", "update"],
    ["--lifecycle", "repair"],
    ["--lifecycle", "rollback"],
    ["--profile", "minimal"],
    ["--with", "tdd-workflow"],
    ["--ecc-path", "unused"],
    ["--all-tools", "--apply"],
  ])("refuses retired route %s without writing", async (...route) => {
    const root = mkdtempSync(join(tmpdir(), "aih-ecc-retired-"));
    roots.push(root);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const program = buildProgram();
      await program.parseAsync(["node", "aih", "ecc", ...route, "--json", "--root", root]);
      const result = JSON.parse(output.mock.calls.map((call) => String(call[0])).join("")) as {
        error: { code: string; message: string };
      };
      expect(result.error.code).toBe("AIH_CONFIG");
      expect(result.error.message).toContain(`aih ecc ${route[0]}`);
      expect(result.error.message).toContain("Run aih ecc");
      expect(process.exitCode).toBe(1);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      output.mockRestore();
      process.exitCode = undefined;
    }
  });

  it("refuses mcp add and preserves removal command registrations", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-ecc-mcp-retired-"));
    roots.push(root);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const program = buildProgram();
      const ecc = program.commands.find((command) => command.name() === "ecc");
      expect(
        ecc?.commands
          .find((command) => command.name() === "mcp")
          ?.commands.map((command) => command.name()),
      ).toContain("remove");
      expect(program.commands.map((command) => command.name())).toEqual(
        expect.arrayContaining(["uninstall", "prune"]),
      );
      await program.parseAsync([
        "node",
        "aih",
        "ecc",
        "mcp",
        "add",
        "test-server",
        "--json",
        "--root",
        root,
      ]);
      const result = JSON.parse(output.mock.calls.map((call) => String(call[0])).join("")) as {
        error: { code: string; message: string };
      };
      expect(result.error.code).toBe("AIH_CONFIG");
      expect(result.error.message).toContain("aih ecc mcp add was retired");
      expect(process.exitCode).toBe(1);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      output.mockRestore();
      process.exitCode = undefined;
    }
  });
});
