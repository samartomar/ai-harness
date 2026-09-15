export const CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION = "0.10.8";

export type CodebaseMemoryNativePayloadTarget =
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64"
  | "win32-arm64";

export interface CodebaseMemoryNativePayloadPin {
  readonly sha256: string;
  readonly size: number;
}

function pin(sha256: string, size: number): CodebaseMemoryNativePayloadPin {
  return Object.freeze({ sha256, size });
}

/**
 * Root executable identities derived from the manifest-authenticated 0.10.8
 * release archives. These authenticate the extracted launch payload, rather
 * than trusting archive validation alone.
 */
export const CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS: Readonly<
  Record<CodebaseMemoryNativePayloadTarget, CodebaseMemoryNativePayloadPin>
> = Object.freeze({
  "darwin-x64": pin(
    "1d5b79257d91973809ee70482781db3d1a78f62fc1cd5d18a5ab0608451d16d4",
    296_064_592,
  ),
  "darwin-arm64": pin(
    "2412e017268bef8f847f38d1b0f79f63185b38c27fe6fba637067bfc87c0eedf",
    297_185_328,
  ),
  "linux-x64": pin("1175645cb30560e7e47d78611cd1bcb509478eaf6d4e51f72fe18327ee9c1351", 293_213_352),
  "linux-arm64": pin(
    "0bf1b3cf3659f6dcdb01bb6313a93dcbcb53e2cd1a52820f024df7a0cf48f44e",
    293_797_736,
  ),
  "win32-x64": pin("b4b403b1d7c4def3785f148b93f345ce8427858f4f5489ce28580c4387a336a6", 296_140_288),
  "win32-arm64": pin(
    "67b0341ee62f07f850d3954e4f387855f90ea8c6c4b7ed41b8a62d61344373a4",
    296_138_752,
  ),
});
