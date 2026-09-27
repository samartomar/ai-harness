import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { eccPolicyDeliveryInspectorV1 } from "../../src/framework-plugin/ecc-read.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  renderPolicyDelivery,
  summarizePolicyDelivery,
} from "../../src/org-policy/policy-delivery-report.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "../framework-plugin/plugin-source.js";
import { eccDescriptorLoad } from "../framework-plugin/source-plugin-mocks.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reports selected ECC Catalog items as developer-managed without an aih receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-policy-ecc-view-"));
  roots.push(root);
  const run = fakeRunner(() => undefined);
  const ctx: PlanContext = {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
  const ecc = await eccPolicyDeliveryInspectorV1(ctx, {
    loadPlugin: () => loadEccFromSource(),
    loadDescriptor: async () => eccDescriptorLoad(),
  });
  const policy = parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "test-1",
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      externalSelections: [
        {
          framework: "ecc",
          items: [
            {
              id: "skill:tdd-workflow",
              kind: "skill",
              source: {
                repository: "affaan-m/ECC",
                commit: "a".repeat(40),
                path: "skills/tdd-workflow",
              },
            },
          ],
        },
      ],
    },
  });
  const report = summarizePolicyDelivery(root, ["claude"], policy, false, {}, "ai-coding", ecc);
  expect(report.components[0]?.state).toBe("developer-managed");
  expect(report.receipt).toBe("absent");
  expect(report.blocking).toBe(false);
  expect(report.selection?.components[0]?.owner).toBe("developer-managed");
  expect(renderPolicyDelivery(report)).toContain("run aih ecc for the exact ECC commands");
});
