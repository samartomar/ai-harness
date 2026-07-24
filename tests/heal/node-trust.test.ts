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
const ROOT_ALT_A_PEM = readFileSync(
  new URL("../fixtures/certs/root-alt-a.pem", import.meta.url),
  "utf8",
);
const ROOT_ALT_B_PEM = readFileSync(
  new URL("../fixtures/certs/root-alt-b.pem", import.meta.url),
  "utf8",
);
const ROOT_ALT_C_PEM = readFileSync(
  new URL("../fixtures/certs/root-alt-c.pem", import.meta.url),
  "utf8",
);
const INTERMEDIATE_PEM = readFileSync(
  new URL("../fixtures/certs/intermediate.pem", import.meta.url),
  "utf8",
);
const LEAF_INTERMEDIATE_PEM = readFileSync(
  new URL("../fixtures/certs/leaf-intermediate.pem", import.meta.url),
  "utf8",
);
const OVERFLOW_INTERMEDIATE_PEM = readFileSync(
  new URL("../fixtures/certs/overflow-intermediate.pem", import.meta.url),
  "utf8",
);

const ROOT_A = certEntry(ROOT_A_PEM);
const ROOT_B = certEntry(ROOT_B_PEM);
const NOT_CA = certEntry(NOT_CA_PEM);
const ALT_ROOTS = [ROOT_ALT_A_PEM, ROOT_ALT_B_PEM, ROOT_ALT_C_PEM]
  .map(certEntry)
  .sort((a, b) =>
    new X509Certificate(a.pem).fingerprint256.localeCompare(
      new X509Certificate(b.pem).fingerprint256,
    ),
  );

const OVERFLOW_ROOTS = Array.from({ length: 9 }, (_, index) =>
  readFileSync(
    new URL(`../fixtures/certs/overflow-root-${index + 1}.pem`, import.meta.url),
    "utf8",
  ),
)
  .map(certEntry)
  .sort((a, b) =>
    new X509Certificate(a.pem).fingerprint256.localeCompare(
      new X509Certificate(b.pem).fingerprint256,
    ),
  );

type ProbeKind = "system-ca" | "capture" | "extra-ca";
type ProbeHandler = (
  kind: ProbeKind,
  origin: string,
  opts: RunOptions | undefined,
  script: string,
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

function candidateCtx(
  handler: ProbeHandler,
  roots: CertEntry[] = [],
  env: NodeJS.ProcessEnv = { EXISTING_SETTING: "preserved" },
): PlanContext {
  const run = fakeRunner((argv, opts) => {
    if (argv[0] !== "node" || argv[1] !== "-e") return undefined;
    const script = argv[2] ?? "";
    const origin = argv[3] ?? "";
    const kind: ProbeKind = script.includes("rejectUnauthorized:false")
      ? "capture"
      : script.includes("rootCertificates")
        ? "extra-ca"
        : "system-ca";
    return handler(kind, origin, opts, script);
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
  vi.restoreAllMocks();
});

describe("selectNodeTrustCandidate", () => {
  it("selects system CA before evaluating an extra bundle", async () => {
    const calls: Array<{ kind: ProbeKind; env: NodeJS.ProcessEnv }> = [];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind, _origin, opts) => {
          calls.push({ kind, env: opts?.env ?? {} });
          if (kind !== "system-ca") throw new Error(`unexpected ${kind} probe`);
          return { code: 0 };
        },
        [],
        {
          EXISTING_SETTING: "preserved",
          NODE_EXTRA_CA_CERTS: "/stale/exact.pem",
          Node_Extra_Ca_Certs: "/stale/mixed.pem",
          node_use_system_ca: "0",
        },
      ),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "system-ca" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({
      EXISTING_SETTING: "preserved",
      NODE_USE_SYSTEM_CA: "1",
    });
    expect(
      Object.keys(calls[0]?.env ?? {}).filter((key) =>
        ["node_use_system_ca", "node_extra_ca_certs"].includes(key.toLowerCase()),
      ),
    ).toEqual(["NODE_USE_SYSTEM_CA"]);
  });

  it("caps aggregate candidate work at its deadline and passes only remaining time", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(129_500)
      .mockReturnValue(129_500);
    const calls: Array<{ kind: ProbeKind; timeoutMs: number | undefined }> = [];

    const candidate = await selectNodeTrustCandidate(
      candidateCtx((kind, _origin, opts) => {
        calls.push({ kind, timeoutMs: opts?.timeoutMs });
        if (kind === "system-ca") return { code: 1 };
        if (kind === "capture") return capturedChain(LEAF_A_PEM);
        throw new Error(`unexpected ${kind} probe`);
      }),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
    expect(calls).toEqual([
      { kind: "system-ca", timeoutMs: 25_000 },
      { kind: "capture", timeoutMs: 500 },
    ]);
    now.mockRestore();
  });

  it("fails closed without starting more candidate probes after the aggregate deadline", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(120_000);
    const calls: ProbeKind[] = [];

    const candidate = await selectNodeTrustCandidate(
      candidateCtx((kind) => {
        calls.push(kind);
        return { code: 1 };
      }),
      ["https://first.example.test", "https://second.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
    expect(calls).toEqual(["system-ca"]);
    now.mockRestore();
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

  it("matches a trusted root through the captured intermediate chain", async () => {
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") {
            return capturedChain(LEAF_INTERMEDIATE_PEM, INTERMEDIATE_PEM);
          }
          return { code: 0 };
        },
        [ALT_ROOTS[0] as CertEntry],
      ),
      ["https://intermediate.example.test"],
    );

    expect(expectExtraCa(candidate).map((cert) => cert.pem)).toEqual([ALT_ROOTS[0]?.pem]);
  });

  it("tries an alternate signing root after the first valid root fails verification", async () => {
    const ordered = ALT_ROOTS.slice(0, 2);
    const attempted: string[][] = [];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx((kind, _origin, opts) => {
        if (kind === "system-ca") return { code: 1 };
        if (kind === "capture") {
          return capturedChain(LEAF_INTERMEDIATE_PEM, INTERMEDIATE_PEM);
        }
        const pems = JSON.parse(opts?.input ?? "[]") as string[];
        attempted.push(pems);
        return { code: pems[0] === ordered[1]?.pem ? 0 : 1 };
      }, ordered),
      ["https://intermediate.example.test"],
    );

    expect(expectExtraCa(candidate).map((cert) => cert.pem)).toEqual([ordered[1]?.pem]);
    expect(attempted).toEqual([[ordered[0]?.pem], [ordered[1]?.pem]]);
  });

  it("selects a shared single root before trying a larger passing union", async () => {
    const [firstOnly, secondOnly, shared] = ALT_ROOTS;
    const attempts: Array<{ origin: string; pems: string[] }> = [];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx((kind, origin, opts) => {
        if (kind === "system-ca") return { code: 1 };
        if (kind === "capture") {
          return capturedChain(LEAF_INTERMEDIATE_PEM, INTERMEDIATE_PEM);
        }
        const pems = JSON.parse(opts?.input ?? "[]") as string[];
        attempts.push({ origin, pems });
        if (pems.length !== 1) return { code: 0 };
        if (pems[0] === shared?.pem) return { code: 0 };
        if (pems[0] === firstOnly?.pem) {
          return { code: origin.includes("first") ? 0 : 1 };
        }
        if (pems[0] === secondOnly?.pem) {
          return { code: origin.includes("second") ? 0 : 1 };
        }
        return { code: 1 };
      }, ALT_ROOTS),
      ["https://first.example.test", "https://second.example.test"],
    );

    expect(expectExtraCa(candidate).map((cert) => cert.pem)).toEqual([shared?.pem]);
    expect(attempts.map(({ pems }) => pems)).toEqual([
      [firstOnly?.pem],
      [firstOnly?.pem],
      [secondOnly?.pem],
      [secondOnly?.pem],
      [shared?.pem],
      [shared?.pem],
    ]);
  });

  it("forces authorization and removes an inherited Node TLS verification bypass", async () => {
    const verified: Array<{ script: string; env: NodeJS.ProcessEnv }> = [];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind, _origin, opts, script) => {
          if (kind === "capture") return capturedChain(LEAF_A_PEM);
          verified.push({ script, env: opts?.env ?? {} });
          return { code: kind === "system-ca" ? 1 : 0 };
        },
        [ROOT_A],
        {
          EXISTING_SETTING: "preserved",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          Node_Tls_Reject_Unauthorized: "0",
          node_tls_reject_unauthorized: "0",
        },
      ),
      ["https://runtime.example.test"],
    );

    expect(candidate.kind).toBe("extra-ca");
    expect(verified).toHaveLength(2);
    for (const call of verified) {
      expect(call.script).toContain("rejectUnauthorized:true");
      expect(call.script).toContain(".authorized");
      expect(
        Object.keys(call.env).filter((key) => key.toLowerCase() === "node_tls_reject_unauthorized"),
      ).toEqual([]);
      expect(call.env.EXISTING_SETTING).toBe("preserved");
    }
  });

  it("fails closed when one origin has too many signing-root candidates", async () => {
    const candidate = await selectNodeTrustCandidate(
      candidateCtx((kind) => {
        if (kind === "system-ca") return { code: 1 };
        if (kind === "capture") return capturedChain(OVERFLOW_INTERMEDIATE_PEM);
        throw new Error("candidate overflow must not reach TLS verification");
      }, OVERFLOW_ROOTS),
      ["https://overflow.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
  });

  it("fails closed when deterministic candidate unions exceed the search bound", async () => {
    const origins = [
      "https://alt-one.example.test",
      "https://alt-two.example.test",
      "https://alt-three.example.test",
      "https://overflow-one.example.test",
      "https://overflow-two.example.test",
      "https://overflow-three.example.test",
    ];
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind, origin) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") {
            return capturedChain(
              origin.includes("overflow") ? OVERFLOW_INTERMEDIATE_PEM : INTERMEDIATE_PEM,
            );
          }
          throw new Error("union overflow must not reach TLS verification");
        },
        [...ALT_ROOTS, ...OVERFLOW_ROOTS.slice(0, 8)],
      ),
      origins,
    );

    expect(candidate).toEqual({ kind: "unresolved" });
  });

  it("fails closed when the trust-root inventory exceeds its input bound", async () => {
    const candidate = await selectNodeTrustCandidate(
      candidateCtx(
        (kind) => {
          if (kind === "system-ca") return { code: 1 };
          if (kind === "capture") return capturedChain(LEAF_A_PEM);
          throw new Error("an oversized root inventory must never reach candidate verification");
        },
        Array.from({ length: 1025 }, () => ROOT_A),
      ),
      ["https://runtime.example.test"],
    );

    expect(candidate).toEqual({ kind: "unresolved" });
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
