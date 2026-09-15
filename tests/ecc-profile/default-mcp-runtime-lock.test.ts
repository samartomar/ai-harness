import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authenticateDefaultMcpRuntimeRoot } from "../../src/ecc-profile/default-mcp-runtime-auth.js";
import {
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
  DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256,
  DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256,
} from "../../src/ecc-profile/default-mcp-runtime-lock.js";

const root = fileURLToPath(new URL("../../src/ecc-profile/default-mcp-runtime/", import.meta.url));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

describe("default local MCP dependency lock", () => {
  it("authenticates the shipped Graph 2.3.8 and Memory 0.10.8 closure", () => {
    const pyproject = readFileSync(`${root}/pyproject.toml`);
    const uvLock = readFileSync(`${root}/uv.lock`);
    expect(sha256(pyproject)).toBe(DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256);
    expect(sha256(uvLock)).toBe(DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256);
    expect(DEFAULT_MCP_DEPENDENCY_LOCK_SHA256).toBe(
      sha256(`${DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256}\0${DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256}`),
    );
    expect(uvLock.toString("utf8")).toContain('name = "code-review-graph"\nversion = "2.3.8"');
    expect(uvLock.toString("utf8")).toContain(
      'hash = "sha256:013ae3c119cc7de337f9e88fe36daef82e2d4def942a014edcf97f126e208547"',
    );
    expect(uvLock.toString("utf8")).toContain('name = "codebase-memory-mcp"\nversion = "0.10.8"');
    expect(uvLock.toString("utf8")).toContain(
      'hash = "sha256:a5e39e6886bbdd7836cadaec13cdeb3ee3648c34fdf88359d9395abccc16287c"',
    );
  });

  it("rejects a modified packaged dependency lock", () => {
    const copy = mkdtempSync(join(tmpdir(), "aih-default-mcp-lock-"));
    try {
      copyFileSync(join(root, "pyproject.toml"), join(copy, "pyproject.toml"));
      copyFileSync(join(root, "uv.lock"), join(copy, "uv.lock"));
      writeFileSync(join(copy, "uv.lock"), "forged dependency closure\n");
      expect(() => authenticateDefaultMcpRuntimeRoot(copy)).toThrow(
        "default MCP runtime uv.lock failed authentication",
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
