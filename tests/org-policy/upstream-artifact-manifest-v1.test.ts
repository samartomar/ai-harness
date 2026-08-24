import { describe, expect, it } from "vitest";
import {
  canonicalUpstreamArtifactManifestV1,
  parseUpstreamArtifactManifestV1Bytes,
  upstreamArtifactManifestDigestV1,
} from "../../src/org-policy/upstream-artifact-manifest-v1.js";

const d = (digit: string) => `sha256:${digit.repeat(64)}`;

function manifest() {
  return {
    format: "aih-upstream-artifact-manifest" as const,
    version: 1 as const,
    decisionId: "decision-custom-mcp",
    subject: {
      kind: "mcp" as const,
      id: "custom-mcp",
      sourceDigest: d("2"),
      subjectDigest: d("3"),
    },
    target: "codex",
    effect: "configure" as const,
    integration: { owner: "organization-platform", version: "1.0.0" },
    files: [
      { path: ".codex/config.toml", sha256: d("4") },
      { path: "vendor/custom-mcp/package.json", sha256: d("5") },
    ],
  };
}

describe("upstream artifact manifest V1", () => {
  it("round-trips one canonical manifest and derives a domain-separated digest", () => {
    const value = manifest();
    const canonical = canonicalUpstreamArtifactManifestV1(value);
    expect(parseUpstreamArtifactManifestV1Bytes(Buffer.from(canonical))).toEqual(value);
    expect(upstreamArtifactManifestDigestV1(value)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts exact mixed-case visible artifact paths", () => {
    const value = {
      ...manifest(),
      files: [
        { path: ".codex/Config.toml", sha256: d("4") },
        { path: "vendor/custom/README.md", sha256: d("5") },
      ],
    };
    expect(
      parseUpstreamArtifactManifestV1Bytes(Buffer.from(canonicalUpstreamArtifactManifestV1(value))),
    ).toEqual(value);
  });

  it.each([
    ["unknown member", { ...manifest(), extra: true }],
    ["unsorted files", { ...manifest(), files: [...manifest().files].reverse() }],
    ["duplicate files", { ...manifest(), files: [manifest().files[0], manifest().files[0]] }],
    [
      "case-fold-equivalent files",
      {
        ...manifest(),
        files: [
          { path: "vendor/custom/manifest.json", sha256: d("4") },
          { path: "vendor/custom/MANIFEST.json", sha256: d("5") },
        ],
      },
    ],
    ["escaping path", { ...manifest(), files: [{ path: "../outside", sha256: d("4") }] }],
    ["backslash path", { ...manifest(), files: [{ path: "vendor\\outside", sha256: d("4") }] }],
    ["absolute path", { ...manifest(), files: [{ path: "C:/outside", sha256: d("4") }] }],
    [
      "Windows alternate data stream",
      { ...manifest(), files: [{ path: "vendor/file.txt:stream", sha256: d("4") }] },
    ],
    [
      "Windows invalid path character",
      { ...manifest(), files: [{ path: "vendor/file?.txt", sha256: d("4") }] },
    ],
    ["control path", { ...manifest(), files: [{ path: "vendor/\u0000file", sha256: d("4") }] }],
    [
      "trailing-dot path segment",
      { ...manifest(), files: [{ path: "vendor./file", sha256: d("4") }] },
    ],
    [
      "trailing-space path segment",
      { ...manifest(), files: [{ path: "vendor /file", sha256: d("4") }] },
    ],
    [
      "reserved Windows device segment",
      { ...manifest(), files: [{ path: "vendor/con.json", sha256: d("4") }] },
    ],
    [
      "AIH custody path",
      { ...manifest(), files: [{ path: ".aih/authority.json", sha256: d("4") }] },
    ],
    [
      "case-folded AIH custody path",
      { ...manifest(), files: [{ path: ".AIH/authority.json", sha256: d("4") }] },
    ],
    [
      "trailing-dot AIH custody alias",
      { ...manifest(), files: [{ path: ".aih./authority.json", sha256: d("4") }] },
    ],
    [
      "trailing-space AIH custody alias",
      { ...manifest(), files: [{ path: ".aih /authority.json", sha256: d("4") }] },
    ],
    [
      "short-name AIH custody alias",
      { ...manifest(), files: [{ path: "AIH~1/authority.json", sha256: d("4") }] },
    ],
    ["unsafe owner", { ...manifest(), integration: { owner: "../owner", version: "1.0.0" } }],
    [
      "unbounded version",
      { ...manifest(), integration: { owner: "owner", version: "x".repeat(129) } },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalUpstreamArtifactManifestV1(value as never)).toThrow();
    expect(
      parseUpstreamArtifactManifestV1Bytes(Buffer.from(JSON.stringify(value))),
    ).toBeUndefined();
  });

  it("rejects noncanonical bytes and the byte ceiling before parsing", () => {
    const canonical = canonicalUpstreamArtifactManifestV1(manifest());
    expect(parseUpstreamArtifactManifestV1Bytes(Buffer.from(`${canonical}\n`))).toBeUndefined();
    expect(
      parseUpstreamArtifactManifestV1Bytes(Buffer.alloc(512 * 1024 + 1, 0x20)),
    ).toBeUndefined();
  });
});
