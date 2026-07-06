import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/guardrails/redact.js";
import { executePlan, summarizeResult } from "../../src/internals/execute.js";
import { digest, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

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

  it("continues to redact existing GitHub token prefixes", () => {
    for (const token of [
      `gho_${"a".repeat(12)}`,
      `ghu_${"b".repeat(12)}`,
      `ghs_${"c".repeat(12)}`,
    ]) {
      expect(redactSecrets(`token ${token}`), token).not.toContain(token);
    }
  });

  it("redacts a bearer token (case-insensitive)", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123")).not.toContain("abc.def-123");
  });

  it("redacts an UPPERCASE KEY=VALUE secret assignment", () => {
    expect(redactSecrets("API_KEY=xyz123")).toBe("[REDACTED]");
    expect(redactSecrets("MY_SECRET=hunter2")).toBe("[REDACTED]");
  });

  it("redacts provider token shapes shared with the detector layer", () => {
    const cases = [
      ["Slack", `xoxb-${"a".repeat(12)}-${"b".repeat(12)}`],
      ["GCP", `AIza${"A".repeat(35)}`],
      ["Azure account key", `AccountKey=${"a".repeat(86)}==`],
      ["Azure SAS", "SharedAccessSignature=sv=2024-01-01&sr=b&sig=abcDEF123%2B456%3D"],
      ["npm", `npm_${"a".repeat(36)}`],
    ] as const;

    for (const [provider, token] of cases) {
      const out = redactSecrets(`leaked ${provider} token: ${token}`);
      expect(out, provider).not.toContain(token);
      expect(out, provider).toContain("[REDACTED]");
    }
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

describe("the redaction chokepoint: executePlan masks digest bodies for EVERY renderer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-redact-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(): PlanContext {
    const run = fakeRunner(() => undefined);
    return {
      root: dir,
      contextDir: ".ai-context",
      apply: false,
      verify: false,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  it("redacts the secret in result.digests so the human summary AND --json are both clean", async () => {
    const built = plan("report", digest("usage roll-up", "saw AKIA1234567890ABCDEF in the logs"));
    const result = await executePlan(built, ctx());

    // The collected digest text is masked at the single chokepoint, upstream of any render.
    expect(result.digests[0]?.text).not.toContain("AKIA1234567890ABCDEF");
    expect(result.digests[0]?.text).toContain("[REDACTED]");

    // Both output paths a consumer can hit are consequently clean:
    const human = summarizeResult(result);
    const asJson = JSON.stringify(result, null, 2); // the `--json` path in commands/run.ts
    for (const out of [human, asJson]) {
      expect(out).not.toContain("AKIA1234567890ABCDEF");
      expect(out).toContain("[REDACTED]");
    }
  });
});
