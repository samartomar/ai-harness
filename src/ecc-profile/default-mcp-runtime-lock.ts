export const DEFAULT_MCP_RUNTIME_PYPROJECT_SHA256 =
  "fed57c2dbf15fac6f83aa3a31b7de43dce496f16b34ceb499c9c3e040dd6f22f";
export const DEFAULT_MCP_RUNTIME_UV_LOCK_SHA256 =
  "feb526cc7101e6c047fc9728f4001a7ebbdc1556d013148b5e1ee6e49434379d";
export const DEFAULT_MCP_DEPENDENCY_LOCK_SHA256 =
  "034ae6c2dcac6fcb8bf647f0b09ced392608397fba53b91ded0389d8f247e79c";

export const CODE_REVIEW_GRAPH_RUNTIME_PIN = {
  package: "code-review-graph==2.3.8",
  sourceCommit: "2c6dae32643572ee528eb9b77dbcc17f58f3a8c9",
  wheelSha256: "013ae3c119cc7de337f9e88fe36daef82e2d4def942a014edcf97f126e208547",
} as const;

export const CODEBASE_MEMORY_RUNTIME_PIN = {
  package: "codebase-memory-mcp==0.10.8",
  sourceCommit: "46ae198fc11cda80e817acbc5f5908d7c2de7032",
  wheelSha256: "a5e39e6886bbdd7836cadaec13cdeb3ee3648c34fdf88359d9395abccc16287c",
  releaseManifestSha256: "9d2e33bdf9c9dc8662079d5b9a1bbf716aa2e62e2ed6cc51cf4ae06d42498787",
  archives: {
    "darwin-x64": {
      name: "codebase-memory-mcp-darwin-amd64.tar.gz",
      sha256: "2b193085410af3801634a522f4b17dcd6699695e015a068393c87817c1d260d4",
    },
    "darwin-arm64": {
      name: "codebase-memory-mcp-darwin-arm64.tar.gz",
      sha256: "9bd840dfb3ec7eaef4f310382057adaa5b0e904df883104d03ffcf39836afd07",
    },
    "linux-x64": {
      name: "codebase-memory-mcp-linux-amd64-portable.tar.gz",
      sha256: "6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325",
    },
    "linux-arm64": {
      name: "codebase-memory-mcp-linux-arm64-portable.tar.gz",
      sha256: "5697d986d9716c913163b4bff7b3a294287f3b843e993bc1ff71e78dcdc21781",
    },
    "win32-x64": {
      name: "codebase-memory-mcp-windows-amd64.zip",
      sha256: "b43ad982994c4d829670749e08d3b622a74bb20041fc0a7d02bef6113f81c34d",
    },
    "win32-arm64": {
      name: "codebase-memory-mcp-windows-arm64.zip",
      sha256: "254b26e819f00bab7f430c5f809d37d22b07bb3eb6427e290e5a27ba5b8e983e",
    },
  },
} as const;

export type CodebaseMemoryPlatform = keyof typeof CODEBASE_MEMORY_RUNTIME_PIN.archives;
