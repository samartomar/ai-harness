import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { DarwinAdapter } from "../../src/platform/darwin.js";

describe("DarwinAdapter trust store", () => {
  it("queries the per-user login keychain alongside the system keychains", async () => {
    const queried: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] !== "security") return undefined;
      const line = argv.join(" ");
      queried.push(line);
      // Return a cert only for the login keychain to prove it is consulted.
      return line.includes("login.keychain-db")
        ? { stdout: "-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n" }
        : undefined;
    });
    const a = new DarwinAdapter(run, { HOME: "/Users/sam" });
    const certs = await a.trustStoreCerts("Corp");
    // path.join uses the host separator, so normalize before matching the macOS path.
    const norm = (s: string) => s.replace(/\\/g, "/");
    expect(
      queried.some((q) => norm(q).includes("/Users/sam/Library/Keychains/login.keychain-db")),
    ).toBe(true);
    expect(certs.length).toBeGreaterThan(0);
  });

  it("consults only the system keychains when HOME is unset", async () => {
    const queried: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "security") queried.push(argv.join(" "));
      return undefined;
    });
    const a = new DarwinAdapter(run, {});
    await a.trustStoreCerts("Corp");
    expect(queried.some((q) => q.includes("login.keychain-db"))).toBe(false);
    expect(queried.some((q) => q.includes("System.keychain"))).toBe(true);
  });
});
