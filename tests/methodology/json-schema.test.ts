import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schemaPath = join(process.cwd(), "schemas", "aih-methodology-qualification.schema.json");

function proposal(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: {
      id: "gstack",
      kind: "hybrid-runtime",
      source: {
        type: "local-git",
        repository: "garrytan/gstack",
        root: "C:/research/gstack",
        requestedRef: "v1.2.0",
        resolvedCommit: "a".repeat(40),
      },
      adapter: {
        id: "builtin:gstack",
        contractVersion: 1,
        implementationHash: "b".repeat(64),
      },
    },
    host: {
      id: "codex",
      version: "0.144.1",
      build: "cbacbb97",
      contractVersion: "codex-0.144.1-windows-x64-v1",
      coverage: "partial",
      scope: "project",
      isolationMode: "profile-home",
      operatingSystem: "windows",
      operatingSystemVersion: "10.0.26200",
      architecture: "x64",
      runtimes: { node: "24.13.1" },
    },
    policyVersion: "enterprise-core-v1",
  };
}

describe("methodology qualification JSON Schema", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync(schemaPath, "utf8")),
  );

  it("accepts the same exact tuple as the runtime schema", () => {
    expect(validate(proposal()), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("rejects unknown fields and non-exact source commits", () => {
    expect(validate({ ...proposal(), surprise: true })).toBe(false);
    const shortCommit = proposal();
    const provider = shortCommit.provider as Record<string, unknown>;
    provider.source = { ...(provider.source as object), resolvedCommit: "deadbeef" };
    expect(validate(shortCommit)).toBe(false);
  });
});
