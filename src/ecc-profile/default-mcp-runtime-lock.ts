export const DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256 =
  "0345e85ba70a163c8d892cb43fd010f745a6a49c1e420cc09f7e9146d75f0c02";
export const DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256 =
  "14b44ebe6d14e85eb4ee77945c56aaef3a35dfbd2ca3d80e7c501ca4670157e9";
export const DEFAULT_MCP_DEPENDENCY_LOCK_SHA256 =
  "4eda4580a665c124551245178e6ba1e6180f51c58eb0663df4b717946af79c8d";

export const CODE_REVIEW_GRAPH_RUNTIME_PIN = {
  package: "code-review-graph==2.3.9",
  sourceCommit: "343ab7cea29d47a3e805381e09f8243a43d43d88",
  wheelSha256: "908500a23f23fe05566090a2e5fce95f7f177d054090a355b46367546db5d910",
} as const;

export const CODEBASE_MEMORY_RUNTIME_PIN = {
  package: "codebase-memory-mcp==0.11.0",
  sourceCommit: "8972ea69c6ad94b1ef1d4ffbf0a92d78d2db1798",
  wheelSha256: "2775931b6615344777926ef6ba4e11330a4b26040be06901d2556edb5e673be7",
  releaseManifestSha256: "5e5a3b25c619ecf8f7349acf38d74f1989b4ec65dfae911d8ceb788969f1cf91",
  archives: {
    "darwin-x64": {
      name: "codebase-memory-mcp-darwin-amd64.tar.gz",
      sha256: "dbf1c73bfcbde64e7dde4cd1320da7afc02e2c972ee1789ae039521411f5132e",
    },
    "darwin-arm64": {
      name: "codebase-memory-mcp-darwin-arm64.tar.gz",
      sha256: "4dee7f38b63740e6751d7a7ed7eb10291c1f2a3ea2415f599dc68370ca0a2d18",
    },
    "linux-x64": {
      name: "codebase-memory-mcp-linux-amd64-portable.tar.gz",
      sha256: "1f9e8293eb2bc5c05cfa27a7e8fc033da6d729ffad525ccfcdaa3fd606306683",
    },
    "linux-arm64": {
      name: "codebase-memory-mcp-linux-arm64-portable.tar.gz",
      sha256: "d62eeb224d5ee3eba3070938ec62cf1033f10b041ec1c4b2fb67f7aef390cc7b",
    },
    "win32-x64": {
      name: "codebase-memory-mcp-windows-amd64.zip",
      sha256: "6eb6beaf261b19e419766e78baf93cbc3cf1c6338cff8fb7c0234859f96d1685",
    },
    "win32-arm64": {
      name: "codebase-memory-mcp-windows-arm64.zip",
      sha256: "52b29881214fce47d529e098308b1de77c40f6812e20a34d588ee4c25b84fd1a",
    },
  },
} as const;

export type CodebaseMemoryPlatform = keyof typeof CODEBASE_MEMORY_RUNTIME_PIN.archives;
