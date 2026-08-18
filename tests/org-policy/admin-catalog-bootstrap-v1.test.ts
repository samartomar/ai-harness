import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  ADMIN_CATALOG_BOOTSTRAP_FILE,
  adminCatalogAttestationRepositoryV1,
  adminCatalogBootstrapPathV1,
  adminCatalogCacheSlotPathV1,
  enterpriseAdminCatalogRootV1,
  parseAdminCatalogBootstrapV1Json,
  resolveAdminCatalogBootstrapV1,
  vibeAdminCatalogRootV1,
} from "../../src/org-policy/admin-catalog-bootstrap-v1.js";
import { bootstrapBytes, bootstrapRecord, channel, sourceId } from "./admin-catalog-fixtures.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-admin-catalog-bootstrap-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeBootstrap(root: string, bytes: Buffer = bootstrapBytes()): string {
  mkdirSync(root, { recursive: true });
  const path = adminCatalogBootstrapPathV1(root);
  writeFileSync(path, bytes);
  return path;
}

describe("admin catalog bootstrap V1", () => {
  it("binds every pinned locator, digest, identity, version, and cache fact from canonical bytes", () => {
    const bootstrap = parseAdminCatalogBootstrapV1Json(bootstrapBytes());
    expect(bootstrap.protocol).toBe("AdminCatalogBootstrapV1");
    expect(bootstrap.catalogArtifactUrl.startsWith("https://")).toBe(true);
    expect(bootstrap.catalogAttestationUrl.startsWith("https://")).toBe(true);
    expect(bootstrap.signedDistributionUrl.startsWith("https://")).toBe(true);
    expect(bootstrap.signedDistributionAttestationUrl.startsWith("https://")).toBe(true);
    expect(bootstrap.expectedAdminWorkflowIdentity).toContain(".github/workflows/");
    expect(bootstrap.expectedSchemaVersion).toBe("1");
    expect(bootstrap.expectedEffectVersion).toBe("1");
    expect(bootstrap.cacheMaxAgeSeconds).toBe(86_400);
    expect(bootstrap.sourceId).toBe(sourceId);
    expect(bootstrap.channel).toBe(channel);
    expect(Object.isFrozen(bootstrap)).toBe(true);
    // The attestation identity is DERIVED from the pinned repository — there is
    // no second, independently settable repository authority in the bootstrap.
    expect(adminCatalogAttestationRepositoryV1(bootstrap)).toBe("aih/supported-catalog");
  });

  it("rejects duplicate keys, malformed UTF-8/Unicode, hostile shapes, and noncanonical bytes", () => {
    const canonical = bootstrapBytes().toString("utf8");
    const duplicate = `${canonical.slice(0, -1)},"sourceId":"other"}`;
    expect(() => parseAdminCatalogBootstrapV1Json(Buffer.from(duplicate, "utf8"))).toThrow();
    expect(() =>
      parseAdminCatalogBootstrapV1Json(Buffer.concat([bootstrapBytes(), Buffer.from([0xff])])),
    ).toThrow();
    expect(() =>
      parseAdminCatalogBootstrapV1Json(
        Buffer.from(`${canonical.slice(0, -1)}}`.replace(sourceId, "e\\ud800"), "utf8"),
      ),
    ).toThrow();
    // A key-reordered (noncanonical) serialization of the same facts is rejected.
    const shuffled = Object.fromEntries(
      Object.entries(JSON.parse(canonical) as Record<string, unknown>).reverse(),
    );
    expect(() =>
      parseAdminCatalogBootstrapV1Json(Buffer.from(JSON.stringify(shuffled), "utf8")),
    ).toThrow();
    for (const hostile of [
      Object.assign(Object.create({ polluted: true }), JSON.parse(canonical)),
      new Proxy({}, { get: () => "x", ownKeys: () => ["sourceId"] }),
      Object.defineProperty({}, "sourceId", { enumerable: true, get: () => sourceId }),
      "not bytes",
      null,
      [],
    ]) {
      expect(() => parseAdminCatalogBootstrapV1Json(hostile)).toThrow();
    }
  });

  it("rejects non-HTTPS, credentialed, fragmented, and non-conforming locators", () => {
    for (const url of [
      "http://catalog.aih.dev/a.json",
      "https://user:pass@catalog.aih.dev/a.json",
      "https://catalog.aih.dev/a.json#frag",
      "https://catalog.aih.dev:8443/a.json",
      "https://catalog.aih.dev/a.json?bundle=1",
      "https://catalog.aih.dev/../a.json",
      "file:///etc/passwd",
      "https:///a.json",
      "not a url",
    ]) {
      expect(
        () =>
          parseAdminCatalogBootstrapV1Json(
            canonicalStrictJsonBytesV1(bootstrapRecord({ catalogArtifactUrl: url })),
          ),
        url,
      ).toThrow();
    }
  });

  it("rejects an out-of-range cache policy, wrong protocol, wrong field set, and unbound state", () => {
    for (const overrides of [
      { cacheMaxAgeSeconds: 0 },
      { cacheMaxAgeSeconds: 1.5 },
      { cacheMaxAgeSeconds: 31_536_001 },
      { cacheMaxAgeSeconds: "86400" },
      { protocol: "AdminCatalogBootstrapV2" },
      { expectedSchemaVersion: "2" },
      { expectedEffectVersion: "2" },
      { headSignerRootSha256: "not-a-digest" },
      { sourceId: "../escape" },
      { channel: "Stable" },
      { expectedAdminWorkflowIdentity: "unbound-workflow" },
      { signedDistributionAttestationUrl: "file:///etc/passwd" },
      { lastGoodCatalogStateBytes: "!!!!" },
      { packagedCatalogStateBytes: Buffer.from("{}", "utf8").toString("base64") },
    ]) {
      expect(
        () =>
          parseAdminCatalogBootstrapV1Json(canonicalStrictJsonBytesV1(bootstrapRecord(overrides))),
        JSON.stringify(overrides),
      ).toThrow();
    }
    // Distinct signer roots are structural: a shared root collapses the split.
    const record = bootstrapRecord();
    expect(() =>
      parseAdminCatalogBootstrapV1Json(
        canonicalStrictJsonBytesV1({
          ...record,
          adminSignerRootSha256: record.headSignerRootSha256,
        }),
      ),
    ).toThrow();
    // An extra field is rejected rather than ignored.
    expect(() =>
      parseAdminCatalogBootstrapV1Json(canonicalStrictJsonBytesV1({ ...record, extra: "x" })),
    ).toThrow();
  });

  it("names one fixed OS/admin-managed enterprise location per platform with no env authority", () => {
    expect(enterpriseAdminCatalogRootV1("win32")).toBe("C:\\ProgramData\\aih\\admin-catalog");
    expect(enterpriseAdminCatalogRootV1("darwin")).toBe(
      "/Library/Application Support/aih/admin-catalog",
    );
    expect(enterpriseAdminCatalogRootV1("linux")).toBe("/etc/aih/admin-catalog");
    expect(enterpriseAdminCatalogRootV1("freebsd")).toBe("/etc/aih/admin-catalog");
    for (const key of ["PROGRAMDATA", "AIH_ADMIN_CATALOG_ROOT", "HOME", "XDG_DATA_HOME"]) {
      const previous = process.env[key];
      process.env[key] = join(workspace, "hijack");
      try {
        expect(enterpriseAdminCatalogRootV1("win32")).toBe("C:\\ProgramData\\aih\\admin-catalog");
        expect(enterpriseAdminCatalogRootV1("linux")).toBe("/etc/aih/admin-catalog");
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });

  it("reads the enterprise bootstrap only from the fixed location and never falls back to vibe", () => {
    const platformAdminRoot = join(workspace, "platform");
    const adminRoot = join(workspace, "admin");
    mkdirSync(adminRoot, { recursive: true });
    // A vibe bootstrap under the target admin root must never satisfy enterprise.
    writeBootstrap(vibeAdminCatalogRootV1(adminRoot));
    expect(() =>
      resolveAdminCatalogBootstrapV1({ adminRoot, platformAdminRoot, posture: "enterprise" }),
    ).toThrow(/enterprise/i);

    writeBootstrap(platformAdminRoot);
    const resolved = resolveAdminCatalogBootstrapV1({
      adminRoot,
      platformAdminRoot,
      posture: "enterprise",
    });
    expect(resolved.provenance).toBe("os-admin-managed");
    expect(resolved.catalogRoot).toBe(resolve(platformAdminRoot));
    expect(resolved.bootstrap.sourceId).toBe(sourceId);
  });

  it("reports visibly weaker local-admin-file provenance for the vibe file under the admin root", () => {
    const adminRoot = join(workspace, "admin");
    const platformAdminRoot = join(workspace, "platform");
    writeBootstrap(platformAdminRoot);
    mkdirSync(adminRoot, { recursive: true });
    // Absent vibe file: the OS-managed file is NOT a fallback for vibe either.
    expect(() =>
      resolveAdminCatalogBootstrapV1({ adminRoot, platformAdminRoot, posture: "vibe" }),
    ).toThrow();

    writeBootstrap(vibeAdminCatalogRootV1(adminRoot));
    const resolved = resolveAdminCatalogBootstrapV1({
      adminRoot,
      platformAdminRoot,
      posture: "vibe",
    });
    expect(resolved.provenance).toBe("local-admin-file");
    expect(resolved.catalogRoot).toBe(resolve(vibeAdminCatalogRootV1(adminRoot)));
    expect(resolved.catalogRoot.startsWith(resolve(adminRoot))).toBe(true);
  });

  it("keeps bootstrap and cache paths strictly contained, canonical, and traversal-safe", () => {
    const platformAdminRoot = join(workspace, "platform");
    writeBootstrap(platformAdminRoot);
    for (const adminRoot of ["relative/admin", "", `${workspace}\0`]) {
      expect(
        () => resolveAdminCatalogBootstrapV1({ adminRoot, platformAdminRoot, posture: "vibe" }),
        adminRoot,
      ).toThrow();
    }

    // A symlinked canonical bootstrap file is refused, not followed.
    const linked = join(workspace, "linked");
    mkdirSync(linked, { recursive: true });
    const target = join(workspace, "outside.json");
    writeFileSync(target, bootstrapBytes());
    try {
      symlinkSync(target, adminCatalogBootstrapPathV1(linked));
    } catch {
      return; // unprivileged Windows sessions cannot symlink; containment is asserted above
    }
    expect(() =>
      resolveAdminCatalogBootstrapV1({
        adminRoot: workspace,
        platformAdminRoot: linked,
        posture: "enterprise",
      }),
    ).toThrow();
  });

  it("refuses a symlinked or junctioned catalog root and parent before reading the bootstrap", () => {
    const outside = join(workspace, "outside-catalog-root");
    writeBootstrap(outside);
    const linkedRoot = join(workspace, "linked-root");
    try {
      symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // unprivileged Windows sessions cannot create directory links
    }
    expect(() =>
      resolveAdminCatalogBootstrapV1({
        adminRoot: workspace,
        platformAdminRoot: linkedRoot,
        posture: "enterprise",
      }),
    ).toThrow();

    const vibeAdminRoot = join(workspace, "vibe-admin-root");
    const outsideParent = join(workspace, "outside-parent");
    writeBootstrap(join(outsideParent, "admin-catalog"));
    mkdirSync(vibeAdminRoot, { recursive: true });
    symlinkSync(
      outsideParent,
      join(vibeAdminRoot, ".aih"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      resolveAdminCatalogBootstrapV1({
        adminRoot: vibeAdminRoot,
        platformAdminRoot: workspace,
        posture: "vibe",
      }),
    ).toThrow();
  });

  it("does not inspect unrelated symlink aliases above the authority boundary", () => {
    const actualBoundary = join(workspace, "actual-authority", "catalog");
    writeBootstrap(actualBoundary);
    const alias = join(workspace, "system-alias");
    try {
      symlinkSync(
        join(workspace, "actual-authority"),
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return; // unprivileged Windows sessions cannot create directory links
    }
    const resolved = resolveAdminCatalogBootstrapV1({
      adminRoot: workspace,
      platformAdminRoot: join(alias, "catalog"),
      posture: "enterprise",
    });
    expect(resolved.bootstrap.sourceId).toBe(sourceId);
  });

  it("derives one deterministic contained cache slot per source and channel", () => {
    const bootstrap = parseAdminCatalogBootstrapV1Json(bootstrapBytes());
    const root = join(workspace, "platform");
    const slot = adminCatalogCacheSlotPathV1(root, bootstrap);
    expect(slot).toBe(adminCatalogCacheSlotPathV1(root, bootstrap));
    expect(slot.startsWith(resolve(root))).toBe(true);
    expect(slot).toMatch(/[/\\]cache[/\\][a-f0-9]{64}\.json$/);
    const other = parseAdminCatalogBootstrapV1Json(
      canonicalStrictJsonBytesV1(bootstrapRecord({ channel: "beta" })),
    );
    expect(adminCatalogCacheSlotPathV1(root, other)).not.toBe(slot);
    expect(ADMIN_CATALOG_BOOTSTRAP_FILE).toBe("admin-catalog-bootstrap.json");
  });
});
