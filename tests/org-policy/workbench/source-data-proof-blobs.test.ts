import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSourceDataProofBlobV1 } from "../../../src/org-policy/workbench/core/source-data-proof-blobs.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("loads only exact immutable digest and size named bytes under an explicit proof root", () => {
  const root = mkdtempSync(join(tmpdir(), "aih-proof-blob-"));
  roots.push(root);
  const bytes = Buffer.from('{"raw":"original report"}');
  const reference = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  const path = join(root, reference.sha256 + ".blob");
  writeFileSync(path, bytes);
  expect(readSourceDataProofBlobV1(reference, root, 1024)).toEqual(bytes);
  expect(() => readSourceDataProofBlobV1(reference, undefined, 1024)).toThrow();
  expect(() =>
    readSourceDataProofBlobV1({ ...reference, bytes: reference.bytes - 1 }, root, 1024),
  ).toThrow();
  expect(() =>
    readSourceDataProofBlobV1({ ...reference, sha256: "../secret" }, root, 1024),
  ).toThrow();
  expect(() => readSourceDataProofBlobV1(reference, root, bytes.length - 1)).toThrow();
  writeFileSync(path, Buffer.alloc(bytes.length, 120));
  expect(() => readSourceDataProofBlobV1(reference, root, 1024)).toThrow();
});
