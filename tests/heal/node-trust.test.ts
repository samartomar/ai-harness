import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NodeTrustCandidate, selectNodeTrustCandidate } from "../../src/heal/node-trust.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunOptions, type RunResult } from "../../src/internals/proc.js";
import type { CertEntry } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const ROOT_A_PEM = readFileSync(new URL("../fixtures/certs/root-a.pem", import.meta.url), "utf8");
const ROOT_B_PEM = readFileSync(new URL("../fixtures/certs/root-b.pem", import.meta.url), "utf8");
const NOT_CA_PEM = readFileSync(new URL("../fixtures/certs/not-ca.pem", import.meta.url), "utf8");
const LEAF_A_PEM = readFileSync(new URL("../fixtures/certs/leaf-a.pem", import.meta.url), "utf8");
const LEAF_B_PEM = readFileSync(new URL("../fixtures/certs/leaf-b.pem", import.meta.url), "utf8");
const LEAF_C_PEM = readFileSync(new URL("../fixtures/certs/leaf-c.pem", import.meta.url), "utf8");

const ROOT_A = certEntry(ROOT_A_PEM);
const ROOT_B = certEntry(ROOT_B_PEM);
const NOT_CA = certEntry(NOT_CA_PEM);

type ProbeKind = "system-ca" | "capture" | "extra-ca";
type ProbeHandler = (
  kind: ProbeKind,
  origin: string,
  opts: RunOptions | undefined,
) => Partial<RunResult> | undefined;

function certEntry(pem: string): CertEntry {
  return { subject: new X509Certificate(pem).subject, pem };
}

function capturedChain(...pems: string[]): Partial<RunResult> {
  return {
    code: 0,
    stdout: JSON.stringify(pems.map((pem) => new X509Certificate(pem).raw.toString("base64"))),
  };
}

function candidateCtx(handler: ProbeHandler, roots: CertEntry[] = []): PlanContext {
  const env: NodeJS.ProcessEnv = { EXISTING_SETTING: "preserved" };
  const run = fakeRunner((argv, opts) => {
    if (argv[0] !== "node" || argv[1] !== "-e") return undefined;
    const script = argv[2] ?? "";
    const origin = argv[3] ?? "";
    const kind: ProbeKind = script.includes("rejectUnauthorized:false")
      ? "capture"
      : script.includes("rootCertificates")
        ? "extra-ca"
        : "system-ca";
    return handler(kind, origin, opts);
  });
  const host = Object.assign(makeHostAdapter({ platform: "linux", run, env }), {
    trustStoreRoots: async () => roots,
  });
  return {
    root: "/tmp/aih-node-trust-test",
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host,
    env,
    options: {},
  };
}

function expectExtraCa(candidate: NodeTrustCandidate): CertEntry[] {
  expect(candidate.kind).toBe("extra-ca");
  return candidate.kind === "extra-ca" ? candidate.certs : [];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("selectNodeTrustCandidate", () => {
  it("selects system CA before evaluating an extra bundle", async () => {
    const calls: Array<{ kind: ProbeKind; env: NodeJS.ProcessEnv }> = [];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx((kind, _origin, opts) => {
        calls.push({ kind, env: opts?.env ?? {} });
        if (kind !== "system-ca") throw new Error(`unexpected ${kind} probe`);
        return { code: 0 };
      }),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "system-ca" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({
      EXISTING_SETTING: "preserved",
      NODE_USE_SYSTEM_CA: "1",
    });
  });

  it("selects only OS-trusted roots that issue the served chain", async () => {
    let candidateInput = "";
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind, _origin, opts) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") return capturedChain(LEAF_A_PEM);
          candidateInput = opts?.input ?? "";
          return { code: 0 };
        },
        [ROOT_B, ROOT_A, ROOT_A],
      ),
      ["https://runtime.example.test"],
    );

    expect(expectExtraCa(candidate).map((cert) => cert.subject)).toEqual([
      "CN=Example Test Root A",
    ]);
    expect(JSON.parse(candidateInput)).toEqual([ROOT_A_PEM]);
  });

  it("returns unresolved when no verified candidate passes", async () => {
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") return capturedChain(LEAF_A_PEM);
          return { code: 1 };
        },
        [ROOT_A],
      ),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
  });

  it("rejects malformed and non-CA trust-store entries", async () => {
    const malformed: CertEntry = {
      subject: "CN=Malformed Test Root",
      pem: "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n",
    };
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") return capturedChain(LEAF_C_PEM);
          throw new Error("an invalid root must never reach candidate verification");
        },
        [malformed, NOT_CA],
      ),
      ["https://nonca.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
  });

  it("rejects roots outside their validity window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") return capturedChain(LEAF_A_PEM);
          throw new Error("an expired root must never reach candidate verification");
        },
        [ROOT_A],
      ),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
  });

  it("deduplicates roots by fingerprint and verifies every divergent origin", async () => {
    const verifiedOrigins: string[] = [];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind, origin) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") {
            return origin.includes("second")
              ? capturedChain(LEAF_B_PEM)
              : capturedChain(LEAF_A_PEM);
          }
          verifiedOrigins.push(origin);
          return { code: 0 };
        },
        [ROOT_B, ROOT_A, ROOT_B],
      ),
      ["https://runtime.example.test", "https://second.example.test"],
    );

    const expectedSubjects = [ROOT_A_PEM, ROOT_B_PEM]
      .map((pem) => new X509Certificate(pem))
      .sort((a, b) => a.fingerprint256.localeCompare(b.fingerprint256))
      .map((cert) => cert.subject);
    expect(expectExtraCa(candidate).map((cert) => cert.subject)).toEqual(expectedSubjects);
    expect(verifiedOrigins).toEqual([
      "https://runtime.example.test",
      "https://second.example.test",
    ]);
  });

  it("fails closed on malformed or credential-bearing origins", async () => {
    let called = false;
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(() => {
        called = true;
        return { code: 0 };
      }),
      ["https://user:secret@runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
    expect(called).toBe(false);
  });

  it("does not trust truncated peer-certificate metadata", async () => {
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") return { ...capturedChain(LEAF_A_PEM), truncated: true };
          throw new Error("truncated metadata must never reach candidate verification");
        },
        [ROOT_A],
      ),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
  });
});
