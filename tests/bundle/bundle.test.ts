import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(out[".aih/fleet-bundle/manifest.json"]?.json).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "ai-coding/project.json",
            sha256: sha256Hex('{"schemaVersion":1}\n'),
          }),
        ]),
      }),
    );
    expect(out[".aih/fleet-bundle/SHA256SUMS"]?.contents).toContain("files/ai-coding/project.json");
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

  it("bundles the skill governance set: skills lock, packs manifest, and expanded skill cards", async () => {
    seed();
    writeFileSync(join(dir, "aih-skills.lock.json"), '{"schemaVersion":1,"skills":[]}\n');
    writeFileSync(join(dir, "aih-packs.json"), '{"schemaVersion":1,"packs":[]}\n');
    mkdirSync(join(dir, "ai-coding", "skill-cards"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "skill-cards", "beta.json"), '{"name":"beta"}\n');
    writeFileSync(join(dir, "ai-coding", "skill-cards", "alpha.json"), '{"name":"alpha"}\n');

    const p = await bundleCommand.plan(ctx());
    const paths = writes(p.actions).map((w) => w.path.replace(/\\/g, "/"));
    expect(paths).toContain(".aih/fleet-bundle/files/aih-skills.lock.json");
    expect(paths).toContain(".aih/fleet-bundle/files/aih-packs.json");
    // dir candidate expands one level, name-sorted
    const cards = paths.filter((p) => p.includes("/files/ai-coding/skill-cards/"));
    expect(cards).toEqual([
      ".aih/fleet-bundle/files/ai-coding/skill-cards/alpha.json",
      ".aih/fleet-bundle/files/ai-coding/skill-cards/beta.json",
    ]);
    expect(writes(p.actions).find((w) => w.path.endsWith("SHA256SUMS"))?.contents).toContain(
      "files/ai-coding/skill-cards/alpha.json",
    );
  });

  it("skips the skill-cards dir silently when absent and refuses hostile entry names", async () => {
    seed();
    const bare = await bundleCommand.plan(ctx());
    expect(
      writes(bare.actions).some((w) => w.path.replace(/\\/g, "/").includes("skill-cards")),
    ).toBe(false);

    mkdirSync(join(dir, "ai-coding", "skill-cards", "nested"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "skill-cards", "ok.json"), '{"name":"ok"}\n');
    writeFileSync(join(dir, "ai-coding", "skill-cards", "x..y.json"), '{"name":"x"}\n');
    writeFileSync(join(dir, "ai-coding", "skill-cards", "nested", "deep.json"), "{}\n");
    const p = await bundleCommand.plan(ctx());
    const cards = writes(p.actions)
      .map((w) => w.path.replace(/\\/g, "/"))
      .filter((path) => path.includes("skill-cards"));
    // one level deep, containment-checked: ok.json only — no `..` name, no nested file
    expect(cards).toEqual([".aih/fleet-bundle/files/ai-coding/skill-cards/ok.json"]);
  });

  it("does not duplicate a file that is both --included and dir-expanded", async () => {
    seed();
    mkdirSync(join(dir, "ai-coding", "skill-cards"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "skill-cards", "alpha.json"), '{"name":"alpha"}\n');
    const p = await bundleCommand.plan(
      ctx({ options: { include: "ai-coding/skill-cards/alpha.json" } }),
    );
    const hits = writes(p.actions).filter(
      (w) => w.path.replace(/\\/g, "/") === ".aih/fleet-bundle/files/ai-coding/skill-cards/alpha.json",
    );
    expect(hits).toHaveLength(1);
  });

  it("keeps absolute output paths normalized for checksum verification on Windows", async () => {
    seed();
    const outDir = join(dir, "absolute-bundle");
    const p = await bundleCommand.plan(ctx({ options: { out: outDir } }));
    const paths = writes(p.actions).map((w) => w.path);

    expect(paths.some((path) => path.includes("\\files\\"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/files/ai-coding/project.json"))).toBe(true);
    expect(writes(p.actions).find((w) => w.path.endsWith("/SHA256SUMS"))?.contents).toContain(
      "files/ai-coding/project.json",
    );
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

  it("verifies GitHub attestations with gh when requested", async () => {
    const root = join(dir, "gh-bundle");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SHA256SUMS"), `${sha256Hex("ok\n")}  files/a.txt\n`);
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === "gh" ? { code: 0, stdout: "verified\n" } : undefined;
    });
    const verifyCtx = ctx({
      run,
      options: { bundle: root, signer: "gh", repo: "samartomar/ai-harness" },
    });
    const p = await verifyCommand.plan(verifyCtx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe === "fleet bundle signature",
    );
    const check = probe?.kind === "probe" ? await probe.run(verifyCtx) : undefined;

    expect(check?.verdict).toBe("pass");
    expect(calls[0]).toEqual([
      "gh",
      "attestation",
      "verify",
      join(root, "SHA256SUMS"),
      "--repo",
      "samartomar/ai-harness",
    ]);
  });
});
