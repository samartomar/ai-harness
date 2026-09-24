import "../core-invocation.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import { executeEccProfileLifecycleCommand } from "../../src/profile/command.js";
import {
  EccProfileRecoveryRefusalError,
  eccProfileRecoveryIdentity,
  readEccProfileOwnership,
} from "../../src/profile/lifecycle.js";
import {
  type EccProjection,
  type RenderedProjectionFile,
  renderEccProjection,
} from "../../src/profile/render.js";
import { evidence, type ProjectionRoots, profile, projectionRoots } from "./render-fixture.js";

/**
 * Test-only: the fixture pins are synthetic, so both renders of the same pin
 * are anchored by replacing the contents of Core's (mocked) installation trust
 * record, oldest first, the way Core appends them.
 */
const coreTrust = vi.hoisted(() => [] as unknown[]);
vi.mock("@aihq/core/framework-host", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ECC_PROFILE_INSTALLATION_TRUST_V1: coreTrust,
}));

function coreAnchors(anchors: readonly unknown[]): void {
  coreTrust.splice(0, coreTrust.length, ...anchors);
}

const PAYLOADS = { "notes.md": "notes\n", "scripts/run.py": "import subprocess\n" } as const;
const targets: string[] = [];

afterEach(() => {
  for (const target of targets.splice(0)) rmSync(target, { recursive: true, force: true });
});

function context(root: string, operation: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { lifecycle: operation },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The fixture source with payloads beside a skill projected unavailable on both clients. */
async function sourceWithPayloads(): Promise<ProjectionRoots> {
  const roots = await projectionRoots();
  const skill = roots.resolved.skills.find((entry) => entry.id === "configure-ecc");
  if (skill === undefined) throw new Error("fixture profile has no configure-ecc");
  for (const [path, content] of Object.entries(PAYLOADS)) {
    const absolute = join(roots.sourceRoot, ...skill.sourcePath.split("/"), ...path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return roots;
}

/**
 * The same pin as the earlier renderer projected it: the unavailable stub
 * pinned to SKILL.md, plus a copy of every payload beside it.
 */
function legacyRender(current: EccProjection): EccProjection {
  const files: RenderedProjectionFile[] = [];
  for (const file of current.files) {
    if (!file.destination.endsWith("/skills/configure-ecc/SKILL.md")) {
      files.push(file);
      continue;
    }
    if (file.provenance.kind !== "derived") throw new Error("expected a derived stub");
    const skillPath = file.provenance.inputs.find((input) => input.path.endsWith("/SKILL.md"));
    if (skillPath === undefined) throw new Error("stub names no SKILL.md input");
    const sourceDirectory = skillPath.path.slice(0, -"/SKILL.md".length);
    const destinationDirectory = file.destination.slice(0, -"/SKILL.md".length);
    const pinned = (path: string, mode: "100644" | "100755") => ({
      kind: "pinned-file" as const,
      sourcePin: file.provenance.sourcePin,
      path,
      rawSha256: sha256(path),
      fileType: "regular" as const,
      mode,
    });
    files.push({ ...file, provenance: pinned(skillPath.path, "100644") });
    for (const [path, content] of Object.entries(PAYLOADS)) {
      const mode = path.startsWith("scripts/") ? "100755" : "100644";
      files.push({
        ...file,
        provenance: pinned(`${sourceDirectory}/${path}`, mode),
        destination: `${destinationDirectory}/${path}`,
        mode,
        normalizedSha256: sha256(content),
        content,
      });
    }
  }
  return { ...current, files };
}

function at(root: string, destination: string): string {
  return join(root, ...destination.split("/"));
}

describe("same-pin ECC profile migration", () => {
  it("updates an installation of an earlier anchored render to the stub-only render, and rolls back", async () => {
    const sources = await sourceWithPayloads();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-same-pin-"));
    targets.push(target);
    try {
      const current = await renderEccProjection(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const legacy = legacyRender(current);
      const legacyIdentity = eccProfileRecoveryIdentity(legacy);
      const currentIdentity = eccProfileRecoveryIdentity(current);
      expect(currentIdentity.commit).toBe(legacyIdentity.commit);
      expect(currentIdentity.sourceClosureSha256).toBe(legacyIdentity.sourceClosureSha256);
      expect(currentIdentity.projectionSha256).not.toBe(legacyIdentity.projectionSha256);

      const stubs = current.files.filter((file) =>
        file.destination.endsWith("/skills/configure-ecc/SKILL.md"),
      );
      expect(stubs).toHaveLength(2);
      const payloads = stubs.flatMap((stub) =>
        Object.keys(PAYLOADS).map((path) => stub.destination.replace(/SKILL\.md$/, path)),
      );
      const withLegacy = { loadProjection: async () => legacy };
      const withCurrent = { loadProjection: async () => current };

      await executeEccProfileLifecycleCommand(context(target, "install"), withLegacy);
      for (const payload of payloads) expect(existsSync(at(target, payload)), payload).toBe(true);
      const operatorFile = ".claude/skills/configure-ecc/operator-notes.md";
      writeFileSync(at(target, operatorFile), "operator\n");
      // A withheld payload the installation lost: repair must not restore it,
      // and update must still migrate.
      rmSync(at(target, payloads[0] as string));

      // Only the installed render is anchored: the changed projection is refused.
      coreAnchors([legacyIdentity]);
      const unanchored = await executeEccProfileLifecycleCommand(
        context(target, "update"),
        withCurrent,
      ).catch((error: unknown) => error);
      expect(unanchored).toBeInstanceOf(EccProfileRecoveryRefusalError);
      expect(String(unanchored)).toMatch(/new projection.*not an anchored/i);
      expect(readEccProfileOwnership(target)?.source).toEqual(legacyIdentity);

      // Core anchors the later render of the same pin: repair of the earlier
      // installation refuses with the update route instead of restoring payloads.
      coreAnchors([legacyIdentity, currentIdentity]);
      await expect(
        executeEccProfileLifecycleCommand(context(target, "repair"), withCurrent),
      ).rejects.toThrow(/superseded.*--lifecycle update/i);
      expect(existsSync(at(target, payloads[0] as string))).toBe(false);

      const updated = await executeEccProfileLifecycleCommand(
        context(target, "update"),
        withCurrent,
      );
      expect(updated.applied).toBe(true);
      for (const payload of payloads) expect(existsSync(at(target, payload)), payload).toBe(false);
      for (const stub of stubs)
        expect(readFileSync(at(target, stub.destination), "utf8")).toBe(stub.content);
      expect(readFileSync(at(target, operatorFile), "utf8")).toBe("operator\n");
      const receipt = readEccProfileOwnership(target);
      expect(receipt?.source).toEqual(currentIdentity);
      expect(receipt?.rollback?.source).toEqual(legacyIdentity);
      expect(receipt?.files.map((file) => file.destination)).not.toContain(payloads[1]);

      await executeEccProfileLifecycleCommand(context(target, "rollback"), withCurrent);
      for (const payload of payloads) {
        const content =
          PAYLOADS[payload.replace(/^.*\/configure-ecc\//, "") as keyof typeof PAYLOADS];
        expect(readFileSync(at(target, payload), "utf8"), payload).toBe(content);
      }
      expect(readFileSync(at(target, operatorFile), "utf8")).toBe("operator\n");
      expect(readEccProfileOwnership(target)?.source).toEqual(legacyIdentity);
    } finally {
      await sources.cleanup();
    }
  }, 120_000);
});
