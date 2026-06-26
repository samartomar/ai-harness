import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/guardrails/redact.js";
import { type PlanResult, summarizeResult } from "../../src/internals/execute.js";

describe("redactSecrets() — secret fixtures", () => {
  it("redacts an AWS access-key id", () => {
    const out = redactSecrets("key is AKIA1234567890ABCDEF here");
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a PEM private-key header", () => {
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED]");
  });

  it("redacts an Anthropic sk-ant key", () => {
    const out = redactSecrets("ANTHROPIC=sk-ant-api03-abcDEF123_456-xyz");
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a GitHub ghp_ token", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactSecrets(`token ${token}`)).not.toContain(token);
  });

  it("redacts a bearer token (case-insensitive)", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123")).not.toContain("abc.def-123");
  });

  it("redacts an UPPERCASE KEY=VALUE secret assignment", () => {
    expect(redactSecrets("API_KEY=xyz123")).toBe("[REDACTED]");
    expect(redactSecrets("MY_SECRET=hunter2")).toBe("[REDACTED]");
  });
});

describe("redactSecrets() — benign text untouched", () => {
  it("leaves ordinary prose alone", () => {
    expect(redactSecrets("the deployment ran successfully")).toBe(
      "the deployment ran successfully",
    );
  });

  it("does not redact a bare lowercase 'token' with no assignment", () => {
    expect(redactSecrets("refresh the token before retrying")).toBe(
      "refresh the token before retrying",
    );
  });
});

describe("the print seam: summarizeResult redacts digest bodies", () => {
  it("masks a secret captured into a digest at the single print chokepoint", () => {
    const result: PlanResult = {
      capability: "report",
      applied: false,
      writes: [],
      docs: [],
      probes: [],
      execs: [],
      digests: [{ describe: "usage roll-up", text: "saw AKIA1234567890ABCDEF in the logs" }],
      backups: [],
    };
    const out = summarizeResult(result);
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).toContain("[REDACTED]");
  });
});
