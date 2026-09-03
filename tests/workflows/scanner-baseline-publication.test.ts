import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("independent Scanner publication lifecycle", () => {
  it("keeps required Core CI on committed evidence only", () => {
    expect(existsSync(resolve(root, ".github/workflows/baseline-evidence.yml"))).toBe(false);
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/^ {2}(push|pull_request):/m);
    expect(workflow).not.toMatch(/refresh-execute|baseline-vet|baseline-sign|baseline:consume/);
    expect(workflow).toContain("npm run baseline:check");
  });

  it("uses an explicit analyzer-free lane to consume exact Scanner publications", () => {
    const workflow = read(".github/workflows/baseline-publication-consume.yml");
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\s*$/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(workflow).toContain("869806438a39a002763659a2708a1ae7fcc3431d");
    expect(workflow).toContain('tag="baseline-v1-$request_sha256"');
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain("gh attestation verify");
    expect(workflow).toContain('--source-digest "$SCANNER_PUBLISHER_COMMIT"');
    expect(workflow).toContain("npm run baseline:consume-publication");
    expect(workflow).toContain("npm run baseline:assemble");
    expect(workflow).not.toMatch(/baseline-vet|baseline-sign|docker|setup-python|setup-uv/);
    expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(workflow).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
  });
});
