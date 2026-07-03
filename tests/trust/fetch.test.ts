import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  assertTrustTreeSafe,
  localFileHash,
  resolveTrustSource,
  safeSourceRelative,
  scrubFetchEnv,
  trustFetchExec,
} from "../../src/trust/fetch.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-trust-fetch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(env: NodeJS.ProcessEnv = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

describe("trust fetch source resolution", () => {
  it("resolves a local source, validates containment, and hashes promoted files", () => {
    const skillDir = join(dir, "skills", "clean");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# Clean\n", "utf8");

    const source = resolveTrustSource("skills/clean", { root: dir });

    expect(source).toMatchObject({ kind: "local", id: "clean" });
    if (source.kind !== "local") throw new Error("expected local source");
    expect(assertTrustTreeSafe(source.root)).toBe(source.root);
    expect(safeSourceRelative(source.root, join(source.root, "SKILL.md"))).toBe("SKILL.md");
    expect(localFileHash(skillPath)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves owner/repo sources and builds a quarantined, scrubbed fetch exec", () => {
    const pin = "a".repeat(40);
    const source = resolveTrustSource("Owner/Repo", { root: dir, pin });
    expect(source).toMatchObject({
      kind: "github",
      id: "owner-repo",
      owner: "Owner",
      repo: "Repo",
      ref: pin,
      pin,
    });
    if (source.kind !== "github") throw new Error("expected GitHub source");

    const action = trustFetchExec(
      source,
      ctx({
        PATH: "safe-bin",
        GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        NODE_EXTRA_CA_CERTS: "corp.pem",
      }),
    );

    expect(action.argv[0]).toBe(process.execPath);
    expect(action.cwd).toBe(source.quarantineRoot);
    expect(action.timeoutMs).toBe(120_000);
    expect(action.env).toMatchObject({ PATH: "safe-bin", NODE_EXTRA_CA_CERTS: "corp.pem" });
    expect(action.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(action.env).not.toHaveProperty("OPENAI_API_KEY");
    rmSync(source.quarantineRoot, { recursive: true, force: true });
  });

  it("creates fresh owner-only GitHub quarantine roots from mkdtemp", () => {
    const first = resolveTrustSource("Owner/Repo", { root: dir, ref: "main" });
    const second = resolveTrustSource("Owner/Repo", { root: dir, ref: "main" });
    try {
      if (first.kind !== "github" || second.kind !== "github") {
        throw new Error("expected GitHub source");
      }

      expect(first.quarantineRoot).not.toBe(second.quarantineRoot);
      expect(first.quarantineRoot).toContain("aih-quarantine-");
      expect(first.treePath).toBe(join(first.quarantineRoot, "tree"));
      expect(first.metadataPath).toBe(join(first.quarantineRoot, "metadata.json"));
      if (process.platform !== "win32") {
        expect(lstatSync(first.quarantineRoot).mode & 0o077).toBe(0);
      }
    } finally {
      if (first.kind === "github") rmSync(first.quarantineRoot, { recursive: true, force: true });
      if (second.kind === "github") rmSync(second.quarantineRoot, { recursive: true, force: true });
    }
  });

  it("rejects --pin values that are not full commit SHAs", () => {
    expect(() => resolveTrustSource("Owner/Repo", { root: dir, pin: "main" })).toThrow(
      /40-character Git commit SHA/i,
    );
    expect(() => resolveTrustSource("Owner/Repo", { root: dir, pin: "A".repeat(40) })).toThrow(
      /lowercase 40-character Git commit SHA/i,
    );
  });

  it("rejects refs that could be interpreted as git options", () => {
    expect(() =>
      resolveTrustSource("Owner/Repo", { root: dir, ref: "--upload-pack=evil" }),
    ).toThrow(/--ref must be a safe Git ref/i);
  });

  it("scrubs secrets while preserving only fetch-safe environment keys", () => {
    expect(
      scrubFetchEnv({
        PATH: "bin",
        HOME: "/home/me",
        AWS_SECRET_ACCESS_KEY: "secret",
        RANDOM_VAR: "drop-me",
        SSL_CERT_FILE: "corp.pem",
        UV_CACHE_DIR: "/cache/uv",
      }),
    ).toEqual({
      PATH: "bin",
      HOME: "/home/me",
      SSL_CERT_FILE: "corp.pem",
      UV_CACHE_DIR: "/cache/uv",
    });
  });

  it("rejects empty, unsupported, and escaping source-relative paths", () => {
    expect(() => resolveTrustSource(" ", { root: dir })).toThrow(/requires a source/);
    expect(() => resolveTrustSource("not a source!", { root: dir })).toThrow(/unsupported/);
    expect(() => safeSourceRelative(dir, join(dirname(dir), "outside.txt"))).toThrow(/escape/);
  });
});
