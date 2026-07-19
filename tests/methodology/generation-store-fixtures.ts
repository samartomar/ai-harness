import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectionPayload } from "../../src/methodology/generation-store-contract.js";
import { planSyntheticProjection } from "../../src/methodology/projection-planner.js";

export const ROOT_BYTES = Buffer.from("# root\n", "utf8");
export const DEPENDENCY_BYTES = Buffer.from("# dependency\n", "utf8");
export const BINARY_ROOT_BYTES = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x41]);
export const BINARY_DEPENDENCY_BYTES = Buffer.from([0xfe, 0x00, 0x7f, 0x0d, 0x0a]);
export const ALTERNATE_ROOT_BYTES = Buffer.from([0x00, 0xff, 0x81, 0x0a, 0x42]);
export const ALTERNATE_DEPENDENCY_BYTES = Buffer.from([0xfd, 0x00, 0x7e, 0x0d, 0x0a]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inertArtifact(id: string, bytes: Uint8Array, dependencies: string[]) {
  return {
    id,
    sourceLocator: `synthetic:${id}`,
    contentDigest: digest(bytes),
    contentDisposition: "inert" as const,
    linkDisposition: "none" as const,
    licenseDisposition: "permissive" as const,
    evidenceDigest: digest(Buffer.concat([Buffer.from("evidence:"), Buffer.from(bytes)])),
    dependencies,
  };
}

function inertEvidence(id: string, bytes: Uint8Array) {
  return {
    artifactId: id,
    sourceLocator: `synthetic:${id}`,
    contentDigest: digest(bytes),
    licenseDisposition: "permissive" as const,
    evidenceDigest: digest(Buffer.concat([Buffer.from("evidence:"), Buffer.from(bytes)])),
  };
}

export function plannedFixture(rootTarget = "rules/root.md") {
  return planSyntheticProjection({
    schemaVersion: 1,
    decisionVersion: "phase-3-decision-v1",
    classifierVersion: "phase-2-classifier-v1",
    policyVersion: "phase-3-policy-v1",
    manifestVersion: 1,
    owner: "aih-methodology",
    classifierInput: {
      schemaVersion: 1,
      requested: ["root"],
      declaredClosure: ["root", "dependency"],
      artifacts: [
        inertArtifact("root", ROOT_BYTES, ["dependency"]),
        inertArtifact("dependency", DEPENDENCY_BYTES, []),
      ],
      evidence: [inertEvidence("root", ROOT_BYTES), inertEvidence("dependency", DEPENDENCY_BYTES)],
    },
    mappings: [
      { artifactId: "root", target: rootTarget },
      { artifactId: "dependency", target: "rules/dependency.md" },
    ],
  });
}

export function blockedFixture() {
  return plannedFixture("../root.md");
}

export function collisionBlockedFixture() {
  return planSyntheticProjection({
    schemaVersion: 1,
    decisionVersion: "phase-3-decision-v1",
    classifierVersion: "phase-2-classifier-v1",
    policyVersion: "phase-3-policy-v1",
    manifestVersion: 1,
    owner: "aih-methodology",
    classifierInput: {
      schemaVersion: 1,
      requested: ["root"],
      declaredClosure: ["root", "dependency"],
      artifacts: [
        inertArtifact("root", ROOT_BYTES, ["dependency"]),
        inertArtifact("dependency", DEPENDENCY_BYTES, []),
      ],
      evidence: [inertEvidence("root", ROOT_BYTES), inertEvidence("dependency", DEPENDENCY_BYTES)],
    },
    mappings: [
      { artifactId: "root", target: "rules" },
      { artifactId: "dependency", target: "rules/dependency.md" },
    ],
  });
}

export function plannedPayloadSet(payloads: readonly ProjectionPayload[]) {
  const first = payloads[0];
  if (!first) throw new Error("payload set must not be empty");
  return planSyntheticProjection({
    schemaVersion: 1,
    decisionVersion: "phase-3-decision-v1",
    classifierVersion: "phase-2-classifier-v1",
    policyVersion: "phase-3-policy-v1",
    manifestVersion: 1,
    owner: "aih-methodology",
    classifierInput: {
      schemaVersion: 1,
      requested: [first.artifactId],
      declaredClosure: payloads.map(({ artifactId }) => artifactId),
      artifacts: payloads.map(({ artifactId, bytes }, index) => {
        const next = payloads[index + 1];
        return inertArtifact(artifactId, bytes, next === undefined ? [] : [next.artifactId]);
      }),
      evidence: payloads.map(({ artifactId, bytes }) => inertEvidence(artifactId, bytes)),
    },
    mappings: payloads.map(({ artifactId }) => ({
      artifactId,
      target: `rules/${artifactId}.md`,
    })),
  });
}

export function payloadFixture(): ProjectionPayload[] {
  return [
    { artifactId: "root", bytes: Buffer.from(ROOT_BYTES) },
    { artifactId: "dependency", bytes: Buffer.from(DEPENDENCY_BYTES) },
  ];
}

export function binaryPayloadFixture(): ProjectionPayload[] {
  return [
    { artifactId: "binary-root", bytes: Buffer.from(BINARY_ROOT_BYTES) },
    { artifactId: "binary-dependency", bytes: Buffer.from(BINARY_DEPENDENCY_BYTES) },
  ];
}

export function alternatePayloadFixture(): ProjectionPayload[] {
  return [
    { artifactId: "binary-root", bytes: Buffer.from(ALTERNATE_ROOT_BYTES) },
    { artifactId: "binary-dependency", bytes: Buffer.from(ALTERNATE_DEPENDENCY_BYTES) },
  ];
}

export function binaryPlannedFixture() {
  return plannedPayloadSet(binaryPayloadFixture());
}

export function alternatePlannedFixture() {
  return plannedPayloadSet(alternatePayloadFixture());
}

export function aggregateOverflowPayloadFixture(): ProjectionPayload[] {
  return Array.from({ length: 9 }, (_, index) => ({
    artifactId: `overflow-${index}`,
    bytes: Buffer.alloc(8 * 1024 * 1024),
  }));
}

export type TemporaryProject = Readonly<{
  sandboxRoot: string;
  projectRoot: string;
}>;

export function makeTemporaryProject(): TemporaryProject {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "aih-methodology-store-"));
  const projectRoot = join(sandboxRoot, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  return Object.freeze({ sandboxRoot, projectRoot });
}

export function makeSiblingCanary(root: TemporaryProject): Readonly<{ canary: string }> {
  const canary = join(root.sandboxRoot, "outside-canary.txt");
  writeFileSync(canary, "outside-canary\n", { mode: 0o600 });
  return Object.freeze({ canary });
}

export function expectedReceiptEntries() {
  const result = plannedFixture();
  if (result.state !== "planned") throw new Error("fixture must plan");
  return result.manifest.entries.map((entry) => ({
    ...entry,
    bytes: entry.artifactId === "root" ? ROOT_BYTES.length : DEPENDENCY_BYTES.length,
  }));
}
