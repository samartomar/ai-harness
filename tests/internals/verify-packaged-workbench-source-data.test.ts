import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  inspectRuntimeDescriptor: vi.fn(),
  records: [] as unknown[],
}));

vi.mock("../../src/org-policy/workbench/core/packaged-source-data.js", () => ({
  packagedWorkbenchSourceDataRecordsV1: () => mocks.records,
}));
vi.mock("../../src/ecc/runtime-descriptor.js", () => ({
  inspectEccRuntimeDescriptorSealV1: mocks.inspectRuntimeDescriptor,
}));
vi.mock("../../src/org-policy/workbench/core/source-data-scanner.js", () => ({
  SourceDataScannerProofV1Schema: { parse: vi.fn() },
  prepareSourceDataScannerEvidenceV1: vi.fn(),
  prepareSourceDataScannerRuntimeFactsV1: vi.fn(),
  sealPreparedEccRuntimeDescriptorV1: vi.fn(),
}));
vi.mock("../../src/internals/bounded-github-source-archive.js", () => ({
  acquireBoundedGithubSourceArchiveV1: mocks.archive,
  forgetAcquiredGithubSourceArchiveV1: vi.fn(),
}));

import { verifyPackagedWorkbenchSourceDataV1 } from "../../src/internals/verify-packaged-workbench-source-data.js";

describe("packaged source runtime descriptor release gate", () => {
  it("rejects a malformed nested runtime seal before archive acquisition", async () => {
    mocks.records.splice(0, mocks.records.length, {
      source: { repository: "fixture/runtime" },
      runtimeDescriptor: { bytesBase64: "e30=", sha256: `sha256:${"0".repeat(64)}` },
    });
    mocks.inspectRuntimeDescriptor.mockImplementation(() => {
      throw new TypeError("malformed runtime descriptor");
    });

    await expect(verifyPackagedWorkbenchSourceDataV1()).rejects.toThrow(
      "malformed runtime descriptor",
    );
    expect(mocks.inspectRuntimeDescriptor).toHaveBeenCalledOnce();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});
