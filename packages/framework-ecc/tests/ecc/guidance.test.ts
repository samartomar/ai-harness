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
  it("omits the home-removal header when there are no home targets", () => {
    expect(eccGuidance(["cursor"], "linux")).not.toContain(
      "From the ECC checkout, preview home-scoped removals:",
    );
  });

  it("includes the home-removal header for a home target", () => {
    expect(eccGuidance(["claude"], "linux")).toContain(
      "From the ECC checkout, preview home-scoped removals:",
    );
  });

  it("runs project targets from the project and names home target scope", () => {
    const text = eccGuidance(
      ["claude", "codex", "opencode", "cursor", "gemini", "zed", "antigravity", "kimi"],
      "linux",
    );
    expect(text).toContain("Home-scoped targets: claude, codex, opencode");
    expect(text).toContain("Project-scoped targets: cursor, gemini, zed, antigravity, kimi");
    expect(text).toContain("cd /path/to/project");
    expect(text).toContain(
      "bash /path/to/ECC/install.sh --profile minimal --target cursor --no-hooks",
    );
    expect(text).toContain("node /path/to/ECC/scripts/uninstall.js --target cursor --dry-run");
    expect(text).not.toContain("cd ECC\n./install.sh --profile minimal --target cursor");
    const windows = eccGuidance(["cursor"], "win32");
    expect(windows).toContain(
      "pwsh /path/to/ECC/install.ps1 --profile minimal --target cursor --no-hooks",
    );
  });
  it("gives the reviewed exact-source commands and labels marketplace routes mutable", () => {
    const text = eccGuidance(["claude", "codex"], "linux");
    expect(text).toContain("git clone https://github.com/affaan-m/ECC.git");
    expect(text).toContain("git -C ECC checkout 5064474d4d762dc9640234a41617cccb79185cec");
    expect(text).toContain("./install.sh --profile minimal --target claude");
    expect(text).toContain("./install.sh --profile minimal --target codex");
    expect(text).toContain("node scripts/uninstall.js --target claude --dry-run");
    expect(text).toContain("bash /path/to/ECC/.kiro/install.sh /path/to/project");
    expect(text).toContain("requires bash (on Windows use Git Bash or WSL)");
    expect(text).toContain("ECC's Kiro script has no uninstall");
    expect(text).not.toContain("bash .kiro/install.sh <project>");
    expect(text).toMatch(/marketplace.*mutable.*do not prove the reviewed pin/is);
    expect(text).toMatch(/MCP.*no exact reviewed command/is);
  });

  // ECC's opencode target validates compiled artefacts under .opencode/dist
  // (scripts/lib/install-targets/opencode-home.js:11-16,52-78) and a fresh clone
  // does not carry them, so the build must precede the opencode install.
  it("builds the OpenCode payload in the ECC checkout before the OpenCode install", () => {
    const text = eccGuidance(["opencode"], "linux");
    const install = text.indexOf("./install.sh --profile minimal --target opencode");
    expect(install).toBeGreaterThan(-1);
    expect(text).toContain("npm install");
    expect(text).toContain("npm run build:opencode");
    expect(text.indexOf("npm install")).toBeLessThan(text.indexOf("npm run build:opencode"));
    expect(text.indexOf("npm run build:opencode")).toBeLessThan(install);
    expect(eccGuidance(["claude"], "linux")).not.toContain("build:opencode");
  });

  // Kimi's adapter is id 'kimi-project', target 'kimi'
  // (scripts/lib/install-targets/kimi-project.js:47-53); the installer and the
  // uninstaller both accept the target value 'kimi'
  // (scripts/lib/install-manifests.js:8).
  it("installs Kimi as a project-scoped target at its registry target value", () => {
    const text = eccGuidance(["kimi"], "linux");
    expect(text).toContain("Project-scoped targets: kimi");
    expect(text).toContain("cd /path/to/project");
    expect(text).toContain("bash /path/to/ECC/install.sh --profile minimal --target kimi");
    expect(text).toContain("node /path/to/ECC/scripts/uninstall.js --target kimi --dry-run");
    expect(text).toContain("node /path/to/ECC/scripts/uninstall.js --target kimi");
    expect(text).not.toContain("kimi-project");
    expect(text).not.toContain("./install.sh --profile minimal --target kimi");
  });

  // ECC's registry has no copilot or windsurf adapter
  // (scripts/lib/install-targets/registry.js:18-34, install-manifests.js:8).
  it("names CLIs ECC has no installer for instead of printing empty target lists", () => {
    const both = eccGuidance(["copilot", "windsurf"], "linux");
    expect(both).toContain("ECC has no installer for copilot");
    expect(both).toContain("ECC has no installer for windsurf");
    expect(both).toContain("git clone https://github.com/affaan-m/ECC.git");

    const only = eccGuidance(["copilot"], "linux");
    expect(only).toContain("ECC has no installer for copilot");
    expect(only).toContain("git -C ECC checkout 5064474d4d762dc9640234a41617cccb79185cec");

    const mixed = eccGuidance(["claude", "copilot"], "linux");
    expect(mixed).toContain("Home-scoped targets: claude");
    expect(mixed).toContain("ECC has no installer for copilot");
  });

  // --profile minimal --target cursor still plans .cursor/hooks and
  // .cursor/hooks.json through platform-configs
  // (manifests/install-profiles.json:4-13, manifests/install-modules.json:110-151,
  // scripts/lib/install-targets/cursor-project.js:164-193), which
  // scripts/lib/install/hook-consent.js:46-66,177-190 treats as hook-runtime
  // materialization, so ECC's installer demands an explicit decision.
  it("carries an explicit hook decision on the Cursor project install", () => {
    const text = eccGuidance(["cursor"], "linux");
    expect(text).toContain(
      "bash /path/to/ECC/install.sh --profile minimal --target cursor --no-hooks",
    );
    expect(text).toMatch(/--enable-hooks turns ECC's hooks on/);
    const gemini = eccGuidance(["gemini"], "linux");
    expect(gemini).toContain("bash /path/to/ECC/install.sh --profile minimal --target gemini");
    expect(gemini).not.toContain("--no-hooks");
    expect(gemini).not.toContain("--enable-hooks");
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

  // Antigravity's adapter writes .agents/ecc-install-state.json
  // (scripts/lib/install-targets/antigravity-project.js:20-25) and Kimi's writes
  // .kimi-code/ecc-install-state.json
  // (scripts/lib/install-targets/kimi-project.js:47-53).
  it("reports the pinned Antigravity and Kimi state paths presence-only", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-ecc-status-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(root, ".agents"), { recursive: true });
    mkdirSync(join(root, ".kimi-code"), { recursive: true });
    writeFileSync(join(root, ".agents", "ecc-install-state.json"), "SECRET_SENTINEL");
    writeFileSync(join(root, ".kimi-code", "ecc-install-state.json"), "SECRET_SENTINEL");
    const text = eccStatus(root, home);
    expect(text).toContain("project .agents/ecc-install-state.json: present");
    expect(text).toContain("project .kimi-code/ecc-install-state.json: present");
    expect(text).not.toContain(".agent/ecc-install-state.json");
    expect(text).not.toContain("SECRET_SENTINEL");
    expect(readFileSync(join(root, ".agents", "ecc-install-state.json"), "utf8")).toBe(
      "SECRET_SENTINEL",
    );
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
