import { describe, expect, it } from "vitest";
import { redactArgv, redactText, scrubHome } from "../../src/support/redact.js";

describe("scrubHome", () => {
  it("replaces the home dir (either separator, case-insensitively)", () => {
    expect(scrubHome("C:\\Users\\sam\\repo\\.env", { USERPROFILE: "C:\\Users\\sam" })).toBe(
      "<home>\\repo\\.env",
    );
    expect(scrubHome("/home/sam/x", { HOME: "/home/sam" })).toBe("<home>/x");
    expect(scrubHome("c:\\users\\sam\\x", { USERPROFILE: "C:\\Users\\sam" })).toBe("<home>\\x");
  });

  it("is a no-op when home is unknown", () => {
    expect(scrubHome("/home/sam/x", {})).toBe("/home/sam/x");
  });
});

describe("redactArgv", () => {
  it("masks sensitive flag values but keeps diagnostic flags like --ca-pattern", () => {
    expect(redactArgv(["aih", "heal", "--token", "abc", "--ca-pattern", "Zscaler"])).toEqual([
      "aih",
      "heal",
      "--token",
      "[REDACTED]",
      "--ca-pattern",
      "Zscaler",
    ]);
  });

  it("masks the --key=value form", () => {
    expect(redactArgv(["--password=hunter2", "--api-key=xyz"])).toEqual([
      "--password=[REDACTED]",
      "--api-key=[REDACTED]",
    ]);
  });

  it("masks command-specific sensitive flags", () => {
    expect(
      redactArgv(["session-guard", "--text", "Use sk-test-not-real-123456"], {
        sensitiveFlags: ["--text"],
      }),
    ).toEqual(["session-guard", "--text", "[REDACTED]"]);
    expect(
      redactArgv(["session-guard", "--text=Use sk-test-not-real-123456"], {
        sensitiveFlags: ["--text"],
      }),
    ).toEqual(["session-guard", "--text=[REDACTED]"]);
  });
});

describe("redactText", () => {
  it("masks secret patterns and scrubs the home path together", () => {
    expect(redactText("key sk-ant-ABCDEFGH12345678 at /home/sam/x", { HOME: "/home/sam" })).toBe(
      "key [REDACTED] at <home>/x",
    );
  });

  it("masks session guard token patterns", () => {
    expect(
      redactText("OPENAI_API_KEY: sk-test-not-real-123456 and github_pat_fake_token_12345", {}),
    ).not.toMatch(/sk-test|github_pat/);
  });
});
