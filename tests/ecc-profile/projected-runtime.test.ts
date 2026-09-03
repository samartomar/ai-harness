import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERENA_RUNTIME_PIN } from "../../src/ecc-profile/mcp-profile.js";
import { SERENA_DEPENDENCY_LOCK_SHA256 } from "../../src/ecc-profile/native-registration.js";

// #611: the native runtime is executed from wherever it was projected, which is
// outside the installed package and therefore has no dependency closure beside
// it. A bare `import "zod"` in a shared chunk makes Node fail ESM resolution
// before the runtime processes any command, so this exercises the built artifact
// from a directory with no ancestor `node_modules` rather than from `src/`.

const repoRoot = process.cwd();
const tsupCli = join(repoRoot, "node_modules", "tsup", "dist", "cli-default.js");
const scratch: string[] = [];
let projected = "";

function temporaryRoot(prefix: string): string {
  // macOS exposes /var as a system alias; resolve so ancestor checks see real paths.
  let parent = realpathSync(tmpdir());
  for (;;) {
    const root = realpathSync(mkdtempSync(join(parent, prefix)));
    if (nearestNodeModules(root) === undefined) {
      scratch.push(root);
      return root;
    }
    rmSync(root, { recursive: true, force: true });
    const next = dirname(parent);
    if (next === parent || next === parse(parent).root) {
      throw new Error(`could not create ${prefix} outside a node_modules ancestor`);
    }
    parent = next;
  }
}

function nearestNodeModules(from: string): string | undefined {
  let cursor = from;
  for (;;) {
    if (existsSync(join(cursor, "node_modules"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor || cursor === parse(cursor).root) return undefined;
    cursor = parent;
  }
}

function runProjected(args: readonly string[], input: string) {
  return spawnSync(process.execPath, [join(projected, "ecc-runtime.js"), ...args], {
    input,
    encoding: "utf8",
    // A resolution failure must surface as output, never as an inherited stdio write.
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeAll(() => {
  const built = temporaryRoot("aih-projected-runtime-build-");
  // Build through the shipped tsup config so the assertion tracks the published
  // artifact rather than a test-local bundling choice.
  const build = spawnSync(process.execPath, [tsupCli, "--out-dir", built], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(build.status, `tsup failed: ${build.stderr}`).toBe(0);
  projected = temporaryRoot("aih-projected-runtime-");
  cpSync(built, projected, { recursive: true });
}, 180_000);

afterAll(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("projected native ECC runtime", () => {
  it("has an explicit ESM marker outside any dependency closure", () => {
    expect(nearestNodeModules(projected)).toBeUndefined();
    expect(existsSync(join(projected, "node_modules"))).toBe(false);
    const marker = readFileSync(join(projected, "package.json"), "utf8");
    expect(marker).toBe('{"type":"module"}\n');
    expect(JSON.parse(marker)).toEqual({ type: "module" });
  });

  it("starts the hook path without resolving a bare dependency import", () => {
    const root = temporaryRoot("aih-projected-runtime-project-");
    const stateRoot = temporaryRoot("aih-projected-runtime-state-");
    mkdirSync(join(stateRoot, "continuity"));
    const result = runProjected(
      ["hook", "--client", "claude", "--root", root, "--state-root", stateRoot],
      JSON.stringify({
        session_id: "session-611",
        transcript_path: join(stateRoot, "transcript.jsonl"),
        cwd: root,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tool-611",
        tool_input: { command: "git commit --no-verify" },
      }),
    );

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).not.toContain("Cannot find package");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBeTypeOf("object");
  }, 60_000);

  it("starts the Serena path without resolving a bare dependency import", () => {
    const root = temporaryRoot("aih-projected-runtime-serena-");
    // Reaching the runtime's own context rejection proves the Serena branch ran
    // with the authenticated pins its module graph carries — the pin and lock
    // constants below only exist once that graph resolved.
    const result = runProjected(
      [
        "serena",
        "--package",
        SERENA_RUNTIME_PIN.package,
        "--dependency-lock-sha256",
        SERENA_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        root,
        "--context",
        "unsupported-context",
        "--mode",
        "no-memories",
        "--project",
        root,
      ],
      "",
    );

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).not.toContain("Cannot find package");
    expect(result.stderr).toContain("Serena context is not accepted");
  }, 60_000);
});
