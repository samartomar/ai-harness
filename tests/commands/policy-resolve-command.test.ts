import { describe, expect, it } from "vitest";
import * as packageApi from "../../src/index.js";
import { buildProgram } from "../../src/program.js";

describe("policy resolve command", () => {
  it("exposes only the bounded evidence-resolution inputs beneath policy", () => {
    const policy = buildProgram().commands.find((command) => command.name() === "policy");
    const resolve = policy?.commands.find((command) => command.name() === "resolve");

    expect(resolve?.registeredArguments.map((argument) => argument.name())).toEqual(["root"]);
    expect(resolve?.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining([
        "--decision <id>",
        "--decision-digest <sha256>",
        "--target <id>",
        "--effect <effect>",
        "--evidence <root-relative-file>",
      ]),
    );
    expect(resolve?.options.map((option) => option.flags)).not.toEqual(
      expect.arrayContaining(["--observation <file>", "--verifier <path>", "--report-only"]),
    );
  });

  it("does not expose qualification capability mints from the package boundary", () => {
    for (const internal of [
      "verifyOrganizationQualificationV1",
      "mintAihSupportedQualificationV1",
      "mintVerifiedQualificationV1",
      "resolvePolicyEvidenceV1",
    ]) {
      expect(packageApi).not.toHaveProperty(internal);
    }
  });
});
