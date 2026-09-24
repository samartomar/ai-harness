export const CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION = "0.11.0";

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
 * Root executable identities derived from the manifest-authenticated 0.11.0
 * release archives. These authenticate the extracted launch payload, rather
 * than trusting archive validation alone.
 */
export const CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS: Readonly<
  Record<CodebaseMemoryNativePayloadTarget, CodebaseMemoryNativePayloadPin>
> = Object.freeze({
  "darwin-x64": pin(
    "69ca71b4b62fe233677851bdf54953e2a6660cf5d687b4d64226b2591b14ed39",
    301_399_520,
  ),
  "darwin-arm64": pin(
    "a67b7ccead5d2ca852051f8619458ab96af41393257b56fb36e523a110265d48",
    302_755_632,
  ),
  "linux-x64": pin("ce11c141431aeadd788506c3a7e6942db8fd438dec369d0707a39ec9fd8c6510", 299_891_744),
  "linux-arm64": pin(
    "403d0fab6204e712916701936a3229dd472bad05080c757ea5177318a80fdbfe",
    299_227_216,
  ),
  "win32-x64": pin("7edcd3807ebcfd85ec1968985964080f2589748da2fc3c7ce9261eebab31ff04", 301_530_624),
  "win32-arm64": pin(
    "5615aa31e3cdbe6155e7096c43d07e62e335fe34d28e489b4cc3ce113e81b4e6",
    301_693_952,
  ),
});
