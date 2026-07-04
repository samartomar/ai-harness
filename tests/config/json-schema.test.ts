import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { generatedConfigSchemas } from "../../src/config/json-schema.js";

const root = process.cwd();

describe("committed JSON Schemas", () => {
  function validateCommittedSchema(path: string, value: unknown): void {
    const schema = JSON.parse(readFileSync(join(root, path), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(value), JSON.stringify(validate.errors, null, 2)).toBe(true);
  }

  function rejectCommittedSchema(path: string, value: unknown): void {
    const schema = JSON.parse(readFileSync(join(root, path), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(value)).toBe(false);
  }

  it("emits editor schemas for .aih-config.json and aih-org-policy.json", () => {
    const schemas = generatedConfigSchemas();

    expect(schemas.map((schema) => schema.path)).toEqual([
      "schemas/aih-config.schema.json",
      "schemas/aih-org-policy.schema.json",
    ]);
    expect(schemas[0]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: ".aih-config.json",
      type: "object",
    });
    expect(schemas[1]?.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "aih-org-policy.json",
      type: "object",
    });
  });

  it("keeps the committed schema files in sync with zod", () => {
    for (const schema of generatedConfigSchemas()) {
      const committed = JSON.parse(readFileSync(join(root, schema.path), "utf8"));
      expect(committed).toEqual(schema.schema);
    }
  });

  it("treats runtime-defaulted fields as optional editor inputs", () => {
    validateCommittedSchema("schemas/aih-config.schema.json", {
      schemaVersion: 1,
      contextDir: "ai-coding",
    });
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      schemaVersion: 1,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      command: { deny: {} },
      trust: {},
    });
  });

  it("rejects githubHost values that are not bare https origins", () => {
    const base = {
      schemaVersion: 1,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
    };
    validateCommittedSchema("schemas/aih-org-policy.schema.json", {
      ...base,
      mcp: { githubHost: "https://github.internal.example" },
    });
    for (const githubHost of [
      "http://github.internal.example",
      "https://github.internal.example/",
      "https://github.internal.example/path",
      "https://github.internal.example?x=1",
      "https://user:pass@github.internal.example",
      "https://github.internal.example#fragment",
    ]) {
      rejectCommittedSchema("schemas/aih-org-policy.schema.json", {
        ...base,
        mcp: { githubHost },
      });
    }
  });
});
