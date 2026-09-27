import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("runs project targets from the project and names home target scope", () => {
    const text = eccGuidance(
      ["claude", "codex", "opencode", "cursor", "gemini", "zed", "antigravity"],
      "linux",
    );
    expect(text).toContain("Home-scoped targets: claude, codex, opencode");
    expect(text).toContain("Project-scoped targets: cursor, gemini, zed, antigravity");
    expect(text).toContain("cd /path/to/project");
    expect(text).toContain("bash /path/to/ECC/install.sh --profile minimal --target cursor");
    expect(text).toContain("node /path/to/ECC/scripts/uninstall.js --target cursor --dry-run");
    expect(text).not.toContain("cd ECC\n./install.sh --profile minimal --target cursor");
    const windows = eccGuidance(["cursor"], "win32");
    expect(windows).toContain("pwsh /path/to/ECC/install.ps1 --profile minimal --target cursor");
  });
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
    expect(text).not.toContain("materialization-v1.json");
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
  ])("has no retired route %s", (...route) => {
    const ecc = buildProgram().commands.find((command) => command.name() === "ecc");
    expect(ecc?.options.some((option) => option.flags.includes(route[0] ?? ""))).toBe(false);
  });

  it("has no MCP mutation subcommands and leaves generic removal commands registered", () => {
    const program = buildProgram();
    const ecc = program.commands.find((command) => command.name() === "ecc");
    expect(ecc?.commands).toEqual([]);
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["uninstall", "prune"]),
    );
  });
});
