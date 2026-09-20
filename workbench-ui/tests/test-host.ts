import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen } from "@testing-library/react";
import { type Mock, vi } from "vitest";
import { packageOnlyPolicyStudioModelV1 } from "../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "../../tests/org-policy/studio-test-fixture.js";
import type { WorkbenchFile, WorkbenchHost } from "../src/host.js";
import { fragmentNavigation } from "../src/navigation.js";

/** Shared fixtures for the component tests: one host, one model, the goldens. */

export interface TestHost extends WorkbenchHost {
  readonly save: Mock<(file: WorkbenchFile) => void>;
  readonly copyText: Mock<(text: string) => Promise<boolean>>;
}

export function createTestHost(
  capabilities: { boundPolicy?: boolean; githubIntake?: boolean; clipboard?: boolean } = {},
): TestHost {
  return {
    capabilities: {
      boundPolicy: capabilities.boundPolicy ?? false,
      githubIntake: capabilities.githubIntake ?? false,
    },
    navigation: fragmentNavigation(),
    async sha256Hex(bytes) {
      return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    },
    save: vi.fn<(file: WorkbenchFile) => void>(),
    // The clipboard is a host capability: a test host can refuse it.
    copyText: vi
      .fn<(text: string) => Promise<boolean>>()
      .mockResolvedValue(capabilities.clipboard ?? true),
  };
}

/** `tinyStudioModel()` with the two hosts the tiny fixture omits. */
export function fixtureModel(): Record<string, unknown> {
  const model = tinyStudioModel() as unknown as Record<string, unknown>;
  (model.catalog as { hosts: unknown[] }).hosts = [
    { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
    { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
  ];
  return model;
}

/**
 * The package-only model: the real catalog, whose selections pull in a managed
 * MCP server, so the managed MCP projection opt-in is reachable. The tiny
 * fixture's own schema rejects a policy with an active MCP control.
 */
export function managedMcpModel(): Record<string, unknown> {
  return packageOnlyPolicyStudioModelV1() as unknown as Record<string, unknown>;
}

export function golden(name: string): string {
  return readFileSync(join(process.cwd(), "tests/org-policy/workbench/goldens", name), "utf8");
}

export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function jsonFile(name: string, text: string): File {
  return new File([text], name, { type: "application/json" });
}

/** The text of every live alert region, joined. */
export function alertText(): string {
  return screen
    .queryAllByRole("alert")
    .map((node) => node.textContent ?? "")
    .join(" ");
}

/** The text of every live status region, joined. */
export function statusText(): string {
  return screen
    .queryAllByRole("status")
    .map((node) => node.textContent ?? "")
    .join(" ");
}
