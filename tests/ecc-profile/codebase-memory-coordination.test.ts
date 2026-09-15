import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCodebaseMemoryCoordinationRoot,
  codebaseMemoryCoordinationRoot,
  prepareCodebaseMemoryCoordinationRoot,
} from "../../src/ecc-profile/codebase-memory-coordination.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  // POSIX rendezvous ancestry must not include the world-writable system temp directory.
  const base = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : homedir(), ".am-")),
  );
  roots.push(base);
  const runtime = join(base, "r");
  mkdirSync(runtime, { mode: 0o700 });
  const project = join(base, "project");
  mkdirSync(project);
  const env = { LOCALAPPDATA: runtime, XDG_RUNTIME_DIR: runtime, HOME: base };
  return { base, runtime, project, env };
}

describe("Codebase Memory coordination roots", () => {
  it("derives a short stable project-specific root without creating it", () => {
    const { env, project } = fixture();
    const a = codebaseMemoryCoordinationRoot(env, project);
    expect(a).toBe(codebaseMemoryCoordinationRoot(env, project));
    expect(a).not.toBe(codebaseMemoryCoordinationRoot(env, `${project}-b`));
    expect(assertCodebaseMemoryCoordinationRoot(a, env, project)).toBe(a);
    expect(existsSync(a)).toBe(false);
  });

  it("keeps long index-state paths out of the Linux socket address", () => {
    const env = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_STATE_HOME: `/home/${"long".repeat(50)}/state`,
    };
    const root = codebaseMemoryCoordinationRoot(env, "/work/project", "linux");
    expect(root).toMatch(/^\/run\/user\/1000\/aih-m-[a-f0-9]{20}$/u);
    expect(
      Buffer.byteLength(`${root}/cbm-daemon-4294967295/cbm-${"f".repeat(16)}.sock`),
    ).toBeLessThan(108);
  });

  it("defers unusable Memory roots until preparation so sibling tools can still plan", () => {
    expect(
      codebaseMemoryCoordinationRoot({ XDG_RUNTIME_DIR: "relative" }, "/work/a", "linux"),
    ).toMatch(/^relative\//u);
    expect(
      codebaseMemoryCoordinationRoot(
        { XDG_RUNTIME_DIR: `/run/${"x".repeat(90)}` },
        "/work/a",
        "linux",
      ),
    ).toContain("x".repeat(90));
    const { project } = fixture();
    const env = { LOCALAPPDATA: "relative", XDG_RUNTIME_DIR: "relative" };
    const root = codebaseMemoryCoordinationRoot(env, project);
    expect(() => prepareCodebaseMemoryCoordinationRoot(root, env, project)).toThrow("absolute");
    const longEnv = { XDG_RUNTIME_DIR: `/run/${"x".repeat(90)}` };
    const longRoot = codebaseMemoryCoordinationRoot(longEnv, "/work/a", "linux");
    expect(() =>
      assertCodebaseMemoryCoordinationRoot(longRoot, longEnv, "/work/a", "linux"),
    ).toThrow("socket");
  });

  it("creates only the exact derived private root and converges", () => {
    const { env, project } = fixture();
    const root = codebaseMemoryCoordinationRoot(env, project);
    const prepared = prepareCodebaseMemoryCoordinationRoot(root, env, project);
    expect(prepared).toBe(realpathSync(root));
    expect(prepareCodebaseMemoryCoordinationRoot(root, env, project)).toBe(prepared);
    if (process.platform !== "win32") expect(lstatSync(prepared).mode & 0o777).toBe(0o700);
  });

  it("rejects a substituted root before writing it", () => {
    const { env, project, base } = fixture();
    const foreign = join(base, "foreign");
    expect(() => prepareCodebaseMemoryCoordinationRoot(foreign, env, project)).toThrow("derived");
    expect(existsSync(foreign)).toBe(false);
  });

  it("rejects a junction above the configured runtime before creating managed children", () => {
    const { env, project, base, runtime } = fixture();
    const alias = join(base, "l");
    symlinkSync(runtime, alias, process.platform === "win32" ? "junction" : "dir");
    const redirected = { ...env, LOCALAPPDATA: alias, XDG_RUNTIME_DIR: alias };
    const root = codebaseMemoryCoordinationRoot(redirected, project);
    expect(() => prepareCodebaseMemoryCoordinationRoot(root, redirected, project)).toThrow(
      "linked",
    );
    expect(existsSync(root)).toBe(false);
  });

  it("rejects a linked managed parent and preserves its target", () => {
    const { env, project, base } = fixture();
    const root = codebaseMemoryCoordinationRoot(env, project);
    const target = join(base, "other");
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    symlinkSync(target, root, process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareCodebaseMemoryCoordinationRoot(root, env, project)).toThrow("linked");
    expect(existsSync(target)).toBe(true);
  });

  it("rejects coordination inside a project", () => {
    const { project } = fixture();
    const env = { LOCALAPPDATA: project, XDG_RUNTIME_DIR: project };
    const root = codebaseMemoryCoordinationRoot(env, project);
    expect(() => prepareCodebaseMemoryCoordinationRoot(root, env, project)).toThrow("outside");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a public runtime directory without tightening its permissions",
    () => {
      const { env, project, base } = fixture();
      const publicRoot = join(base, "p");
      mkdirSync(publicRoot, { mode: 0o755 });
      const changed = { ...env, XDG_RUNTIME_DIR: publicRoot };
      const root = codebaseMemoryCoordinationRoot(changed, project);
      expect(() => prepareCodebaseMemoryCoordinationRoot(root, changed, project)).toThrow(
        "private",
      );
      expect(lstatSync(publicRoot).mode & 0o777).toBe(0o755);
      expect(existsSync(root)).toBe(false);
    },
  );
});
