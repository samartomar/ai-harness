import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  command as bundleCommand,
  sha256Hex,
  verifyBundleChecksums,
  verifyCommand,
} from "../../src/bundle/index.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-bundle-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

function seed(): void {
  mkdirSync(join(dir, "ai-coding"), { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, "ai-coding", "project.json"), '{"schemaVersion":1}\n');
  writeFileSync(join(dir, "aih-org-policy.json"), '{"schemaVersion":1}\n');
  writeFileSync(join(dir, ".claude", "managed-settings.json"), '{"managed":true}\n');
  writeFileSync(join(dir, ".mcp.json"), '{"mcpServers":{}}\n');
}

function writes(actions: Awaited<ReturnType<typeof bundleCommand.plan>>["actions"]): WriteAction[] {
  return actions.filter((a): a is WriteAction => a.kind === "write");
}

describe("bundle command", () => {
  it("builds a deterministic fleet bundle with copied artifacts, manifest, and SHA256SUMS", async () => {
    seed();
    const p = await bundleCommand.plan(ctx({ options: { out: ".aih/fleet-bundle" } }));
    const out = Object.fromEntries(writes(p.actions).map((w) => [w.path.replace(/\\/g, "/"), w]));

    expect(out[".aih/fleet-bundle/files/ai-coding/project.json"]?.contents).toBe(
      '{"schemaVersion":1}\n',
    );
    expect(out[".aih/fleet-bundle/files/aih-org-policy.json"]?.contents).toBe(
      '{"schemaVersion":1}\n',
    );
    expect(out[".aih/fleet-bundle/manifest.json"]?.json).toMatchObject({
      schemaVersion: 1,
      files: expect.arrayContaining([
        { path: "ai-coding/project.json", sha256: sha256Hex('{"schemaVersion":1}\n') },
      ]),
    });
    expect(out[".aih/fleet-bundle/SHA256SUMS"]?.contents).toContain(
      "files/ai-coding/project.json",
    );
  });

  it("honors --include and emits signing as a thin cosign exec", async () => {
    seed();
    mkdirSync(join(dir, ".config", "enterprise-ca"), { recursive: true });
    writeFileSync(join(dir, ".config", "enterprise-ca", "corporate-root-ca.pem"), "PEM\n");
    const p = await bundleCommand.plan(
      ctx({
        options: {
          out: ".aih/fleet-bundle",
          include: ".config/enterprise-ca/corporate-root-ca.pem",
          sign: "cosign",
        },
      }),
    );
    expect(
      writes(p.actions).some(
        (w) =>
          w.path.replace(/\\/g, "/") ===
          ".aih/fleet-bundle/files/.config/enterprise-ca/corporate-root-ca.pem",
      ),
    ).toBe(true);
    const sign = p.actions.find((a) => a.kind === "exec");
    expect(sign?.kind === "exec" ? sign.argv[0] : "").toBe("cosign");
    expect(sign?.kind === "exec" ? sign.allowFailure : false).toBe(true);
  });
});

describe("verify-bundle command", () => {
  it("passes when SHA256SUMS matches and fails when a bundled file drifts", () => {
    const root = join(dir, "bundle");
    mkdirSync(join(root, "files"), { recursive: true });
    writeFileSync(join(root, "files", "a.txt"), "ok\n");
    writeFileSync(join(root, "SHA256SUMS"), `${sha256Hex("ok\n")}  files/a.txt\n`);

    expect(verifyBundleChecksums(root).verdict).toBe("pass");
    writeFileSync(join(root, "files", "a.txt"), "tampered\n");
    const res = verifyBundleChecksums(root);
    expect(res.verdict).toBe("fail");
    expect(res.detail).toContain("a.txt");
  });

  it("plans checksum and signature probes", async () => {
    const p = await verifyCommand.plan(ctx({ options: { bundle: ".aih/fleet-bundle" } }));
    expect(p.actions.filter((a) => a.kind === "probe").map((a) => a.describe)).toEqual([
      "fleet bundle checksums",
      "fleet bundle signature",
    ]);
  });
});
