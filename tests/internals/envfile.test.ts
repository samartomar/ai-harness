import { describe, expect, it } from "vitest";
import {
  formatExport,
  removeManagedBlock,
  upsertManagedBlock,
} from "../../src/internals/envfile.js";

const vars = [
  { key: "NODE_EXTRA_CA_CERTS", value: "/home/u/ca.pem" },
  { key: "X", value: "a b" },
];

describe("envfile managed blocks", () => {
  it("inserts a managed block into an empty file", () => {
    const out = upsertManagedBlock("", "certs", vars, "posix");
    expect(out).toContain("# >>> aih managed (certs) >>>");
    expect(out).toContain("export NODE_EXTRA_CA_CERTS=/home/u/ca.pem");
    expect(out).toContain("export X='a b'");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("is idempotent — re-running yields byte-identical output", () => {
    const once = upsertManagedBlock("", "certs", vars, "posix");
    const twice = upsertManagedBlock(once, "certs", vars, "posix");
    expect(twice).toBe(once);
  });

  it("preserves user lines outside the managed block", () => {
    const existing = "export USER_VAR=1\n";
    const out = upsertManagedBlock(existing, "certs", vars, "posix");
    expect(out).toContain("export USER_VAR=1");
  });

  it("renders durable non-selected unsets before selected exports", () => {
    const render = upsertManagedBlock as unknown as (
      existing: string,
      scope: string,
      selected: typeof vars,
      shell: "posix" | "powershell",
      unsetKeys: string[],
    ) => string;

    const posix = render("", "heal-node-trust", vars, "posix", ["NODE_USE_SYSTEM_CA"]);
    expect(posix.indexOf("unset NODE_USE_SYSTEM_CA")).toBeLessThan(
      posix.indexOf("export NODE_EXTRA_CA_CERTS"),
    );

    const powershell = render("", "heal-node-trust", vars, "powershell", ["NODE_USE_SYSTEM_CA"]);
    expect(powershell.indexOf("$env:NODE_USE_SYSTEM_CA = $null")).toBeLessThan(
      powershell.indexOf("$env:NODE_EXTRA_CA_CERTS"),
    );
  });

  it("formats PowerShell exports", () => {
    expect(formatExport({ key: "A", value: "b" }, "powershell")).toBe("$env:A = 'b'");
  });

  it("renders PowerShell values as inert single-quoted literals", () => {
    const value = "C:\\$HOME\\$(Get-Item env:USERNAME)\\`tick\\O'Brien.pem";

    expect(formatExport({ key: "NODE_EXTRA_CA_CERTS", value }, "powershell")).toBe(
      "$env:NODE_EXTRA_CA_CERTS = 'C:\\$HOME\\$(Get-Item env:USERNAME)\\`tick\\O''Brien.pem'",
    );
  });

  it("preserves CRLF line endings when present", () => {
    const out = upsertManagedBlock("a\r\nb\r\n", "s", [{ key: "K", value: "v" }], "posix");
    expect(out.includes("\r\n")).toBe(true);
  });

  it("removeManagedBlock strips the block but keeps user lines", () => {
    const withBlock = upsertManagedBlock("export U=1\n", "certs", vars, "posix");
    const removed = removeManagedBlock(withBlock, "certs");
    expect(removed).toContain("export U=1");
    expect(removed).not.toContain("aih managed (certs)");
  });
});
