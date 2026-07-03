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
});
