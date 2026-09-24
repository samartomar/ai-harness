import { describe, expect, it } from "vitest";
import {
  actionForCompilerDeclarationV1,
  compilerRegistrationForInputFormatV1,
  registeredCompilerInputFormatsV1,
} from "../../../../src/org-policy/workbench/compilers/formats.js";

// Catalog produces these source bundles; Core keeps only their reviewed format
// identities and capability restrictions so admitted signed bundles verify.
describe("reviewed compiler format registrations", () => {
  it("retains every admitted source-bundle format identity without its producer", () => {
    expect(registeredCompilerInputFormatsV1).toEqual([
      "built-in/v1",
      "organization-authoring-manifest/v1",
      "pinned-baseline/v1",
      "pinned-component-collection/v1",
      "pinned-skill-collection/v1",
    ]);
    for (const inputFormat of registeredCompilerInputFormatsV1) {
      const registration = compilerRegistrationForInputFormatV1(inputFormat);
      expect(`${registration.id}/v${registration.version}`).toBe(
        inputFormat === "organization-authoring-manifest/v1"
          ? "organization-manifest/v1"
          : inputFormat,
      );
    }
  });

  it("keeps each format's reviewed kind restrictions", () => {
    expect(actionForCompilerDeclarationV1("pinned-baseline/v1", "anything")).toBe(
      "record-selection",
    );
    expect(actionForCompilerDeclarationV1("built-in/v1", "mcp")).toBe("record-request");
    expect(actionForCompilerDeclarationV1("built-in/v1", "hook")).toBe("record-request");
    expect(actionForCompilerDeclarationV1("pinned-skill-collection/v1", "skill")).toBe(
      "record-selection",
    );
    expect(() => actionForCompilerDeclarationV1("pinned-skill-collection/v1", "mcp")).toThrow(
      /unsupported compiler declaration kind mcp/,
    );
    expect(actionForCompilerDeclarationV1("pinned-component-collection/v1", "hook")).toBe(
      "record-request",
    );
    expect(actionForCompilerDeclarationV1("pinned-component-collection/v1", "profile")).toBe(
      "record-selection",
    );
    expect(() => actionForCompilerDeclarationV1("pinned-component-collection/v1", "agent")).toThrow(
      /unsupported compiler declaration kind agent/,
    );
  });

  it("still refuses an unreviewed format", () => {
    expect(() => compilerRegistrationForInputFormatV1("pinned-anything/v1")).toThrow(
      /unregistered compiler input format pinned-anything\/v1/,
    );
  });
});
