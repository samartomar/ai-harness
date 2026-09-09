import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writePackagedSourceProofBlobV1 } from "../../src/internals/verify-packaged-workbench-source-data.js";

it("reuses an identical shared attestation without accepting altered existing proof bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "aih-package-shared-proof-"));
  try {
    const bytes = Buffer.from("original attestation");
    const reference = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      bytesBase64: bytes.toString("base64"),
    };
    writePackagedSourceProofBlobV1(root, reference, bytes);
    expect(() => writePackagedSourceProofBlobV1(root, reference, bytes)).not.toThrow();
    const path = join(root, `${reference.sha256}.blob`);
    expect(readFileSync(path)).toEqual(bytes);
    writeFileSync(path, Buffer.alloc(bytes.length, 120));
    expect(() => writePackagedSourceProofBlobV1(root, reference, bytes)).toThrow();
    expect(readFileSync(path)).toEqual(Buffer.alloc(bytes.length, 120));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
