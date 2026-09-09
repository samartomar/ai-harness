import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWorkbenchSourceDataV1 } from "../../../src/org-policy/workbench/core/source-data.js";
import { registerWorkbenchDataCommandsV1 } from "../../../src/org-policy/workbench/data-command.js";
import { packagedPreparedWorkbenchCatalogV1 } from "../../../src/org-policy/workbench/prepared-catalog.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("source data operator commands", () => {
  it("prepares, explicitly signs, and imports without changing its trust policy or existing files", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-data-command-"));
    roots.push(root);
    vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", join(root, "local-verifier"));
    const store = join(root, "store");
    mkdirSync(store);
    const key = generateKeyPairSync("ed25519");
    const keyId = createHash("sha256")
      .update(key.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
    const trust = JSON.stringify({
      version: 1,
      authorities: [
        {
          keyId,
          publicKeyPem: key.publicKey.export({ format: "pem", type: "spki" }).toString(),
          role: "workbench-source-data/v1",
          sources: ["source:mattpocock"],
        },
      ],
    });
    writeFileSync(join(store, "trust.json"), trust);
    writeFileSync(
      join(root, "test-key.pem"),
      key.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    writeFileSync(
      join(root, "source.json"),
      JSON.stringify(
        extractWorkbenchSourceDataV1(
          packagedPreparedWorkbenchCatalogV1().bundle,
          "source:mattpocock",
        ),
      ),
    );
    const log = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const invoke = (args: string[]) => {
      const command = new Command("policy");
      registerWorkbenchDataCommandsV1(command);
      return command.parseAsync([...args, "--apply"], { from: "user" });
    };
    await invoke([
      "data",
      "prepare",
      "--source",
      "source:mattpocock",
      "--source-bundle",
      join(root, "source.json"),
      "--sequence",
      "1",
      "--out",
      join(root, "payload.json"),
    ]);
    expect(JSON.parse(readFileSync(join(root, "payload.json"), "utf8")).previousDigest).toBeNull();
    await invoke([
      "data",
      "sign",
      "--input",
      join(root, "payload.json"),
      "--key",
      join(root, "test-key.pem"),
      "--trust",
      join(store, "trust.json"),
      "--out",
      join(root, "signed.json"),
    ]);
    await invoke(["data", "import", "--input", join(root, "signed.json"), "--store", store]);
    expect(
      JSON.parse(readFileSync(join(store, "active.json"), "utf8")).sources["source:mattpocock"]
        .active,
    ).toMatch(/^sha256:/);
    expect(readFileSync(join(store, "trust.json"), "utf8")).toBe(trust);
    expect(log.mock.calls.flat().join("")).not.toContain("PRIVATE KEY");
    await expect(
      invoke([
        "data",
        "prepare",
        "--source",
        "source:mattpocock",
        "--source-bundle",
        join(root, "source.json"),
        "--sequence",
        "1",
        "--out",
        join(root, "payload.json"),
      ]),
    ).rejects.toThrow(/EEXIST/);
    await expect(
      invoke([
        "data",
        "prepare",
        "--source",
        "source:wrong",
        "--source-bundle",
        join(root, "source.json"),
        "--sequence",
        "1",
        "--out",
        join(root, "wrong.json"),
      ]),
    ).rejects.toThrow(/identity mismatch/);
  });
});
