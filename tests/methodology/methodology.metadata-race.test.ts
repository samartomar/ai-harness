import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];

function validIntent(commit: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    selection: {
      provider: "ecc",
      source: {
        host: "github.com",
        owner: "affaan-m",
        repo: "ECC",
        commit,
        checkout: "provider-source",
      },
      components: [{ id: "method-routing" }],
      providerAdapter: "ecc-static-v1",
      hostAdapter: "claude-code-static-v1",
      compatibility: {
        host: "claude-code",
        hostVersion: "2.1.183",
        executableSha256: "b".repeat(64),
        os: "win32",
        architecture: "x64",
        runtime: "node-26",
        policyContext: "unmanaged",
      },
    },
  })}\n`;
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) realFs.rmSync(root, { recursive: true, force: true });
  }
});

describe("methodology Phase 1 descriptor metadata binding", () => {
  it.runIf(process.platform === "linux")(
    "fails closed when valid same-size bytes replace the intent immediately before reading",
    async () => {
      const root = realFs.mkdtempSync(join(tmpdir(), "aih-methodology-metadata-race-"));
      temporaryRoots.push(root);
      const path = join(root, "methodology.intent.json");
      const initial = validIntent("a".repeat(40));
      const replacement = validIntent("c".repeat(40));
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(initial));
      realFs.writeFileSync(path, initial, "utf8");
      let rewrites = 0;

      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          readSync(
            descriptor: number,
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: number | null,
          ): number {
            rewrites += 1;
            actual.writeFileSync(path, replacement, "utf8");
            return actual.readSync(descriptor, buffer, offset, length, position);
          },
        };
      });

      const { runMethodologyCommand } = await import("../../src/methodology/index.js");
      let stdout = "";
      const exitCode = runMethodologyCommand(
        "inspect",
        { root, intent: "methodology.intent.json", json: true },
        {
          write: (text) => {
            stdout += text;
          },
          writeError: () => undefined,
        },
      );

      expect(rewrites).toBe(1);
      expect(exitCode).toBe(3);
      expect(JSON.parse(stdout)).toMatchObject({ outcome: "fail-closed" });
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed when the verified descriptor returns a short read",
    async () => {
      const root = realFs.mkdtempSync(join(tmpdir(), "aih-methodology-short-read-"));
      temporaryRoots.push(root);
      realFs.writeFileSync(
        join(root, "methodology.intent.json"),
        validIntent("a".repeat(40)),
        "utf8",
      );

      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          readSync(
            _descriptor: number,
            _buffer: NodeJS.ArrayBufferView,
            _offset: number,
            length: number,
            _position: number | null,
          ): number {
            return length - 1;
          },
        };
      });

      const { runMethodologyCommand } = await import("../../src/methodology/index.js");
      let stdout = "";
      const exitCode = runMethodologyCommand(
        "inspect",
        { root, intent: "methodology.intent.json", json: true },
        {
          write: (text) => {
            stdout += text;
          },
          writeError: () => undefined,
        },
      );

      expect(exitCode).toBe(3);
      expect(JSON.parse(stdout)).toMatchObject({ outcome: "fail-closed" });
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed before reading when descriptor metadata changes after opening",
    async () => {
      const root = realFs.mkdtempSync(join(tmpdir(), "aih-methodology-pre-read-change-"));
      temporaryRoots.push(root);
      realFs.writeFileSync(
        join(root, "methodology.intent.json"),
        validIntent("a".repeat(40)),
        "utf8",
      );
      let fileStats = 0;
      let reads = 0;

      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          fstatSync(descriptor: number, options: { bigint: true }) {
            const info = actual.fstatSync(descriptor, options);
            if (!info.isFile()) return info;
            fileStats += 1;
            if (fileStats !== 2) return info;
            const changed = Object.assign(Object.create(Object.getPrototypeOf(info)), info);
            changed.ctimeNs += 1n;
            return changed;
          },
          readSync(
            descriptor: number,
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: number | null,
          ): number {
            reads += 1;
            return actual.readSync(descriptor, buffer, offset, length, position);
          },
        };
      });

      const { runMethodologyCommand } = await import("../../src/methodology/index.js");
      let stdout = "";
      const exitCode = runMethodologyCommand(
        "inspect",
        { root, intent: "methodology.intent.json", json: true },
        {
          write: (text) => {
            stdout += text;
          },
          writeError: () => undefined,
        },
      );

      expect(fileStats).toBe(2);
      expect(reads).toBe(0);
      expect(exitCode).toBe(3);
      expect(JSON.parse(stdout)).toMatchObject({ outcome: "fail-closed" });
    },
  );
});
