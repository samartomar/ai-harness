export interface SupportedCustodyPathInputV2 {
  posture: "enterprise" | "vibe";
  platform: "win32" | "darwin" | "linux";
  root: string;
}

export function supportedCustodyRootV2(input: SupportedCustodyPathInputV2): string {
  if (input.posture === "vibe")
    return `${input.root.replace(/[\\/]$/, "")}/.aih/supported-qualification/v2`;
  if (input.platform === "win32") return "C:\\ProgramData\\aih\\supported-qualification\\v2";
  return input.platform === "darwin"
    ? "/Library/Application Support/aih/supported-qualification/v2"
    : "/etc/aih/supported-qualification/v2";
}

export function supportedCustodyLockV2(
  input: SupportedCustodyPathInputV2,
): string | { external: true; path: string; trustedBase: string } {
  const root = supportedCustodyRootV2(input);
  return input.posture === "vibe"
    ? ".aih/supported-qualification/v2/locks/commit.lock"
    : {
        external: true,
        path: `${root}${input.platform === "win32" ? "\\" : "/"}locks${input.platform === "win32" ? "\\" : "/"}commit.lock`,
        trustedBase: root,
      };
}
