import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { buildProgram } from "../../src/program.js";

let root: string;
let stdout: ReturnType<typeof vi.spyOn>;
let savedRef: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-command-"));
  savedRef = process.env.AIH_ECC_REF;
  delete process.env.AIH_ECC_REF;
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  stdout.mockRestore();
  rmSync(root, { recursive: true, force: true });
  if (savedRef === undefined) delete process.env.AIH_ECC_REF;
  else process.env.AIH_ECC_REF = savedRef;
  process.exitCode = undefined;
});

describe("registered ECC command", () => {
  it("previews only the exact-pinned evidence acquisition before apply", async () => {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program.parseAsync([
      "node",
      "aih",
      "ecc",
      "--cli",
      "claude",
      "--json",
      "--no-log",
      "--root",
      root,
    ]);

    const raw = stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    const result = JSON.parse(raw) as {
      capability: string;
      execs: Array<{ argv: string[]; ran: boolean }>;
    };
    expect(result.capability).toBe("ecc: acquire exact baseline source");
    expect(result.execs).toEqual([expect.objectContaining({ ran: false })]);
    expect(JSON.stringify(result)).toContain(baselineCatalogById("ecc").pinnedSha);
    expect(JSON.stringify(result)).not.toContain("npx");
    expect(process.exitCode ?? 0).toBe(0);
  }, 20_000);
});
