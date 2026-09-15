import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { digest, type PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { assembleViewV9, buildAihDataV9, HYDRATE_FN, reportHtmlV9 } from "../../src/report/v9.js";
import { V9_DEMO } from "../../src/report/v9-demo.js";
import { v9ExtraDigests } from "../../src/report/v9-panels.js";

const observation = {
  requested: true,
  targetCli: "opencode",
  source: "local-unsigned-observation",
  recordState: "current",
  reasons: [],
  observedAt: "2026-09-13T15:00:00.000Z",
  expiresAt: "2026-09-13T16:00:00.000Z",
  supported: "verified",
  discovered: "verified",
  exercised: "verified",
  restart: "verified",
  enforcement: "verified",
  operation: { server: "fixture", tool: "fixture_probe" },
  restrictions: [
    { id: "protected-read", boundary: "client-shell", status: "verified" },
    { id: "tcp-connect", boundary: "mcp-subprocess", status: "verified" },
  ],
};

function readiness(runtimeEvidence?: unknown, policyDelivery?: unknown) {
  return digest("Developer readiness", "", {
    banner: "NOT READY",
    score: 42,
    grade: "at-risk",
    blockers: [{ id: "required-resource", title: "Required runtime absent", cmd: "aih heal" }],
    unverified: [
      { id: "required-mcp", title: "Another required MCP is unverified", cmd: "aih heal" },
    ],
    mcp: {
      servers: [
        {
          targetCli: "opencode",
          configPath: "opencode.json",
          name: "fixture",
          selected: true,
          required: "unspecified",
          state: "unverified",
          detail: "Configured; bounded calls reported separately",
          nextStep: "aih ready",
        },
      ],
      issues: [],
    },
    ...(runtimeEvidence === undefined ? {} : { runtimeEvidence }),
    ...(policyDelivery === undefined ? {} : { policyDelivery }),
  });
}

describe("v9 runtime observations beside preflight", () => {
  it("keeps required policy delivery and guidance limits identical in static and hydrated HTML", () => {
    const policyDelivery = {
      policyVersion: "harbor-2",
      blocking: true,
      policyBlocked: true,
      targets: ["codex"],
      unsupportedTargets: [],
      receipt: "valid",
      excludedOptionalAssets: ["ecc/skill:frontend-patterns"],
      unrequestedOwnedComponents: [],
      nativeLoading: "unverified",
      detail: "Receipt bytes do not prove native loading or practice enforcement.",
      nextStep: "aih policy evaluate --json",
      components: [
        {
          id: "skill:tdd-workflow",
          source: {
            repository: "fictional/adopter",
            commit: "a".repeat(40),
            path: "skills/tdd-workflow",
          },
          state: "drifted",
          files: [],
          nativeLoading: "unverified",
          practiceEffect: "guidance",
        },
      ],
    };
    const digests = [readiness(observation, policyDelivery)];
    const data = buildAihDataV9(digests);
    expect(data.ready?.policyDelivery).toEqual(policyDelivery);
    expect(data.ready?.banner).toBe("NOT READY");
    const window = new Window({
      url: "http://localhost/",
      settings: { disableJavaScriptEvaluation: true },
    });
    try {
      window.document.write(reportHtmlV9("Policy delivery", digests));
      const before = window.document.querySelector("#sec-ready .grid")?.textContent;
      for (const value of [
        "Required policy content",
        "harbor-2",
        "skill:tdd-workflow",
        "drifted",
        "guidance",
        "Native loading: unverified",
        "frontend-patterns",
        "Exercised: verified",
        "NOT READY",
      ])
        expect(before).toContain(value);
      const hydrate = new Function(`return (${HYDRATE_FN})`)() as (
        doc: unknown,
        view: unknown,
      ) => void;
      hydrate(window.document, assembleViewV9(data, V9_DEMO));
      expect(window.document.querySelector("#sec-ready .grid")?.textContent).toBe(before);
    } finally {
      window.happyDOM.close();
    }
  });
  it.each([false, true])(
    "materializes readiness before rendering (runtime requested: %s)",
    async (runtimeRequested) => {
      const root = mkdtempSync(join(tmpdir(), "aih-v9-runtime-"));
      const run = fakeRunner(() => undefined);
      const context: PlanContext = {
        root,
        contextDir: "ai-coding",
        apply: false,
        verify: false,
        json: true,
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
        env: { HOME: root, USERPROFILE: root },
        options: {
          v9: true,
          cli: ["opencode"],
          ...(runtimeRequested ? { runtimeEvidence: join(root, "missing.json") } : {}),
        },
      };
      try {
        const data = buildAihDataV9(await v9ExtraDigests(context));
        expect(data.ready?.banner).toBe("NOT READY");
        expect(data.ready?.blockers.length).toBeGreaterThan(0);
        const html = assembleViewV9(data, V9_DEMO).sections["sec-ready"]?.html;
        expect(html).toContain("NOT READY");
        if (runtimeRequested) {
          expect(data.ready?.runtimeEvidence).toMatchObject({
            recordState: "unavailable",
            reasons: ["observation-file-unavailable"],
            exercised: "unverified",
          });
          expect(html).toContain("observation-file-unavailable");
        } else {
          expect(data.ready).not.toHaveProperty("runtimeEvidence");
          expect(html).not.toContain("Current runtime observation");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("omits the observation section unless explicitly requested", () => {
    const data = buildAihDataV9([readiness()]);
    expect(data.ready).not.toHaveProperty("runtimeEvidence");
    expect(assembleViewV9(data, V9_DEMO).sections["sec-ready"]?.html).not.toContain(
      "Current runtime observation",
    );
  });

  it("carries the evaluated data unchanged and preserves preflight blockers", () => {
    const data = buildAihDataV9([readiness(observation)]);
    expect(data.ready?.runtimeEvidence).toEqual(observation);
    expect(data.ready?.banner).toBe("NOT READY");
    expect(data.ready?.blockers).toHaveLength(1);
    expect(data.ready?.unverified).toHaveLength(1);
    const html = assembleViewV9(data, V9_DEMO).sections["sec-ready"]?.html ?? "";
    for (const value of [
      "Required runtime absent",
      "Configured; bounded calls reported separately",
      "fixture_probe",
      "2026-09-13T15:00:00.000Z",
      "2026-09-13T16:00:00.000Z",
      "protected-read",
      "client-shell",
      "tcp-connect",
      "mcp-subprocess",
      "unsigned",
    ]) {
      expect(html).toContain(value);
    }
    expect(html).toContain("Supported: verified");
    expect(html).toContain("Discovered: verified");
    expect(html).toContain("Exercised: verified");
    expect(html).toContain("Restart: verified");
  });

  it("keeps a warning when a current operation has unverified restart or restrictions", () => {
    const partial = { ...observation, restart: "unverified", enforcement: "unverified" };
    const html =
      assembleViewV9(buildAihDataV9([readiness(partial)]), V9_DEMO).sections["sec-ready"]?.html ??
      "";
    expect(html).toContain('badge warn">current');
    expect(html).toContain("Exercised: verified");
    expect(html).toContain("Restart: unverified");
  });

  it.each(["unavailable", "invalid", "stale"])(
    "renders %s evidence without a success badge",
    (recordState) => {
      const current = {
        ...observation,
        recordState,
        reasons: ["target-binding-changed"],
        supported: "unverified",
        discovered: "unverified",
        exercised: "unverified",
        restart: "unverified",
        enforcement: "unverified",
        restrictions: observation.restrictions.map((row) => ({ ...row, status: "unverified" })),
      };
      const html =
        assembleViewV9(buildAihDataV9([readiness(current)]), V9_DEMO).sections["sec-ready"]?.html ??
        "";
      expect(html).toContain(`badge warn">${recordState}`);
      expect(html).toContain("target-binding-changed");
      expect(html).toContain("Exercised: unverified");
      expect(html).not.toContain("Exercised: verified");
      expect(html).toContain("NOT READY");
    },
  );

  it("uses the same escaped observation in static and hydrated HTML", () => {
    const input = {
      ...observation,
      reasons: ["<img src=x onerror=alert(1)>"],
      operation: { server: "fixture", tool: "<script>bad()</script>" },
    };
    const digests = [readiness(input)];
    const page = reportHtmlV9("Runtime observation", digests);
    const window = new Window({
      url: "http://localhost/",
      settings: { disableJavaScriptEvaluation: true },
    });
    try {
      window.document.write(page);
      const before = window.document.querySelector("#sec-ready .grid")?.textContent;
      expect(before).toContain("Exercised: verified");
      expect(before).toContain("<script>bad()</script>");
      const hydrate = new Function(`return (${HYDRATE_FN})`)() as (
        doc: unknown,
        view: unknown,
      ) => void;
      hydrate(window.document, assembleViewV9(buildAihDataV9(digests), V9_DEMO));
      expect(window.document.querySelector("#sec-ready .grid")?.textContent).toBe(before);
      expect(window.document.querySelector("#sec-ready script, #sec-ready img")).toBeNull();
    } finally {
      window.happyDOM.close();
    }
  });
});
