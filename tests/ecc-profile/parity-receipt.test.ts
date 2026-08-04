import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildNativeEccRegistration } from "../../src/ecc-profile/native-registration.js";
import {
  buildEccProfileParityReceipt,
  eccProfileParityReceiptDigest,
  serializeEccProfileParityReceipt,
} from "../../src/ecc-profile/parity-receipt.js";
import { renderEccProjectionWithTrust } from "../../src/ecc-profile/render.js";
import { evidence, profile, projectionRoots } from "./render-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registration(root: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-parity-state-"));
  roots.push(stateRoot);
  const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
  const cliScript = join(stateRoot, "cli.js");
  writeFileSync(executable, "runtime", { mode: 0o755 });
  writeFileSync(cliScript, "cli\n");
  return buildNativeEccRegistration({ root, stateRoot, executable, cliScript });
}

describe("ECC profile parity receipt", () => {
  it("accounts for every authenticated client mapping and native registration policy", async () => {
    const sources = await projectionRoots();
    const target = mkdtempSync(join(tmpdir(), "aih-ecc-parity-target-"));
    roots.push(target);
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const receipt = buildEccProfileParityReceipt(projection, registration(target));

      expect(receipt.source.commit).toBe(profile.source.commit);
      for (const client of [receipt.clients.claude, receipt.clients.codex]) {
        expect(client.skills.map((entry) => entry.id)).toEqual(
          projection.clients[client.client].skills.map((entry) => entry.id).sort(),
        );
        expect(client.roles.map((entry) => entry.id)).toEqual(
          projection.clients[client.client].roles.map((entry) => entry.id).sort(),
        );
        expect(client.workflows.map((entry) => entry.id)).toEqual(
          projection.clients[client.client].workflows.map((entry) => entry.id).sort(),
        );
        expect(
          [...client.skills, ...client.roles, ...client.workflows].every(
            (entry) =>
              entry.transport === "native" ||
              entry.transport === "normalized" ||
              entry.transport === "unavailable",
          ),
        ).toBe(true);
      }
      expect(receipt.native.mcp.selected).toEqual([
        "code-review-graph",
        "codebase-memory-mcp",
        "context7",
        "serena",
      ]);
      expect(receipt.native.mcp.disabled).toEqual([
        "ecc-memory-mcp",
        "github",
        "sequential-thinking",
        "token-savior",
      ]);
      expect(receipt.native.hooks.claude).toContain("PreCompact");
      expect(receipt.native.hooks.codex).toContain("PreCompact");
      expect(receipt.native.registrationFiles.map((entry) => entry.destination)).toEqual([
        ".claude/settings.json",
        ".codex/config.toml",
        ".codex/hooks.json",
        ".mcp.json",
      ]);
    } finally {
      await sources.cleanup();
    }
  }, 120_000);

  it("is path-independent, deterministic, and fails closed on omitted or ambiguous mappings", async () => {
    const sources = await projectionRoots();
    const firstTarget = mkdtempSync(join(tmpdir(), "aih-ecc-parity-first-"));
    const secondTarget = mkdtempSync(join(tmpdir(), "aih-ecc-parity-second-"));
    roots.push(firstTarget, secondTarget);
    try {
      const projection = await renderEccProjectionWithTrust(
        profile,
        evidence,
        sources,
        await sources.createTrust(),
      );
      const first = buildEccProfileParityReceipt(projection, registration(firstTarget));
      const second = buildEccProfileParityReceipt(projection, registration(secondTarget));
      expect(serializeEccProfileParityReceipt(first)).toBe(
        serializeEccProfileParityReceipt(second),
      );
      expect(eccProfileParityReceiptDigest(first)).toMatch(/^[a-f0-9]{64}$/);

      const omitted = structuredClone(projection);
      omitted.clients.codex.skills.pop();
      expect(() => buildEccProfileParityReceipt(omitted, registration(firstTarget))).toThrow(
        /skill.*complete|mapping.*skill|omitted/i,
      );

      const ambiguous = structuredClone(projection);
      const duplicate = ambiguous.clients.codex.workflows[0];
      if (!duplicate) throw new Error("fixture has no workflow");
      ambiguous.clients.codex.workflows.push({ ...duplicate });
      expect(() => buildEccProfileParityReceipt(ambiguous, registration(firstTarget))).toThrow(
        /ambiguous|duplicate/i,
      );
    } finally {
      await sources.cleanup();
    }
  }, 120_000);
});
