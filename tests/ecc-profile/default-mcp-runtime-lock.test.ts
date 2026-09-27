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
import { DEFAULT_MCP_EXCLUDE_NEWER } from "../../src/tools/developer-tools-operations.js";

const root = fileURLToPath(new URL("../../src/ecc-profile/default-mcp-runtime/", import.meta.url));
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

describe("default local MCP dependency lock", () => {
  it("authenticates the shipped Graph 2.3.9 and Memory 0.11.0 closure", () => {
    const pyproject = readFileSync(`${root}/pyproject.toml`);
    const uvLock = readFileSync(`${root}/uv.lock`);
    expect(sha256(pyproject)).toBe(DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256);
    expect(sha256(uvLock)).toBe(DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256);
    expect(DEFAULT_MCP_DEPENDENCY_LOCK_SHA256).toBe(
      sha256(`${DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256}\0${DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256}`),
    );
    expect(uvLock.toString("utf8")).toContain('name = "code-review-graph"\nversion = "2.3.9"');
    expect(uvLock.toString("utf8")).toContain(
      'hash = "sha256:908500a23f23fe05566090a2e5fce95f7f177d054090a355b46367546db5d910"',
    );
    expect(uvLock.toString("utf8")).toContain('name = "codebase-memory-mcp"\nversion = "0.11.0"');
    expect(uvLock.toString("utf8")).toContain(
      'hash = "sha256:2775931b6615344777926ef6ba4e11330a4b26040be06901d2556edb5e673be7"',
    );
  });

  it("syncs with the resolution cutoff the shipped lock records", () => {
    // Setup runs `uv sync --locked --no-config`, which ignores pyproject settings, so the
    // cutoff it passes through UV_EXCLUDE_NEWER must equal the one recorded in the lock.
    const uvLock = readFileSync(`${root}/uv.lock`, "utf8");
    const pyproject = readFileSync(`${root}/pyproject.toml`, "utf8");
    expect(uvLock).toContain(`[options]\nexclude-newer = "${DEFAULT_MCP_EXCLUDE_NEWER}"\n`);
    expect(pyproject).toContain(`exclude-newer = "${DEFAULT_MCP_EXCLUDE_NEWER}"`);
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
