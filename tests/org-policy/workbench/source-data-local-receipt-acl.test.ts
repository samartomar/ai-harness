import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  sourceDataReceiptDigestsV1,
  writeSourceDataLocalReceiptV1,
} from "../../../src/org-policy/workbench/core/source-data-local-receipt.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

it.skipIf(process.platform !== "win32")(
  "rechecks directory and key ACLs together on every existing-key write",
  () => {
    const root = mkdtempSync(join(tmpdir(), "aih-verifier-acl-"));
    try {
      const store = join(root, "store");
      const verifier = join(root, "verifier");
      mkdirSync(store);
      vi.stubEnv("AIH_WORKBENCH_VERIFIER_HOME", verifier);
      const receipt = {
        ...sourceDataReceiptDigestsV1(`sha256:${"1".repeat(64)}`, {}, {}),
        verifiedAt: "2026-09-09T00:00:00.000Z",
        expiresAt: "2026-09-10T00:00:00.000Z",
      };
      writeSourceDataLocalReceiptV1(store, receipt);
      vi.mocked(execFileSync).mockClear();
      writeSourceDataLocalReceiptV1(store, receipt);
      expect(execFileSync).toHaveBeenCalledTimes(1);
      const options = vi.mocked(execFileSync).mock.calls[0]![2];
      expect(options?.env).toMatchObject({
        AIH_VERIFIER_DIRECTORY: verifier,
        AIH_VERIFIER_KEY: join(verifier, "verification-key.pkcs8.pem"),
        AIH_VERIFIER_INITIALIZE: "0",
      });
      // The next operation must observe a changed real ACL, rather than reuse a
      // previous permission decision. Only this temporary fixture is modified.
      const script =
        "$ErrorActionPreference='Stop';$p=$env:AIH_TEST_ACL_DIRECTORY;$a=[System.IO.Directory]::GetAccessControl($p);$r=New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]'S-1-1-0','Read','Allow');$a.AddAccessRule($r);[System.IO.Directory]::SetAccessControl($p,$a)";
      execFileSync(
        join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
          env: { ...process.env, AIH_TEST_ACL_DIRECTORY: verifier },
          stdio: "pipe",
        },
      );
      expect(() => writeSourceDataLocalReceiptV1(store, receipt)).toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
