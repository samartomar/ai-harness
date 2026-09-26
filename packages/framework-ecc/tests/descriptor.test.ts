import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readEccDescriptor, readEccHookControlInventory } from "../src/descriptor.js";
import {
  CATALOG_DESCRIPTOR_SHA256,
  descriptorFromDocument,
  descriptorOf,
  fixtureDescriptorBytes,
  PINNED_COMMIT,
  PINNED_SECTION_FIXTURES,
  pinnedDescriptor,
  pinnedDescriptorDocument,
  pinnedSectionBytes,
} from "./context.js";

type Section = Record<string, unknown>;
type Doc = {
  sections: { vendorLock: Section; hookControlInventory: Section };
} & Record<string, unknown>;

function mutated(change: (document: Doc) => void) {
  const document = pinnedDescriptorDocument() as unknown as Doc;
  change(document);
  return descriptorFromDocument(document);
}

describe("readEccDescriptor", () => {
  it("accepts Catalog's ECC descriptor bytes and reads the pinned source", () => {
    const descriptor = descriptorOf(fixtureDescriptorBytes());
    expect(descriptor.sha256).toBe(CATALOG_DESCRIPTOR_SHA256);
    const read = readEccDescriptor(descriptor);
    expect(read.source).toEqual({ owner: "affaan-m", repo: "ECC", commit: PINNED_COMMIT });
    expect(read.sha256).toBe(CATALOG_DESCRIPTOR_SHA256);
  });

  it("accepts a descriptor carrying Catalog's section bytes produced at the pinned commit", () => {
    for (const section of ["profileEvidence", "hookControlInventory"] as const) {
      const digest = createHash("sha256").update(pinnedSectionBytes(section)).digest("hex");
      expect(digest, section).toBe(PINNED_SECTION_FIXTURES[section].sha256);
    }
    const read = readEccDescriptor(pinnedDescriptor());
    expect(read.source).toEqual({ owner: "affaan-m", repo: "ECC", commit: PINNED_COMMIT });
  });

  it("refuses bytes whose digest is not the one Core loaded", () => {
    const descriptor = { ...descriptorOf(fixtureDescriptorBytes()), sha256: "0".repeat(64) };
    expect(() => readEccDescriptor(descriptor)).toThrow(/digest .* does not match/);
  });

  it("refuses another framework's bytes", () => {
    const descriptor = {
      ...descriptorOf(fixtureDescriptorBytes()),
      frameworkId: "superpowers" as const,
    };
    expect(() => readEccDescriptor(descriptor)).toThrow(/bytes are for framework "superpowers"/);
  });

  it("refuses an unknown envelope key, format or version", () => {
    const extra = mutated((d) => {
      d.extra = 1;
    });
    const format = mutated((d) => {
      d.format = "x";
    });
    const version = mutated((d) => {
      d.version = 2;
    });
    expect(() => readEccDescriptor(extra)).toThrow(/unknown key extra/);
    expect(() => readEccDescriptor(format)).toThrow(/format is "x"/);
    expect(() => readEccDescriptor(version)).toThrow(/version is 2/);
  });

  it("refuses a Catalog that pins another ECC commit", () => {
    const descriptor = mutated((d) => {
      (d.sections.vendorLock as Record<string, unknown>).pinnedSha = "f".repeat(40);
    });
    expect(() => readEccDescriptor(descriptor)).toThrow(/supports affaan-m\/ECC@5064474d/);
  });
});

describe("readEccHookControlInventory", () => {
  it("reads Catalog's 45-row inventory at the pinned commit and ECC's three profiles", () => {
    const inventory = readEccHookControlInventory(readEccDescriptor(pinnedDescriptor()));
    expect(inventory.provenance.commit).toBe(PINNED_COMMIT);
    expect(inventory.hooks).toHaveLength(45);
    expect(inventory.profiles.map((profile) => profile.id)).toEqual([
      "minimal",
      "standard",
      "strict",
    ]);
    expect(inventory.hooks.filter((hook) => hook.disableEligible)).toHaveLength(44);
    expect(
      inventory.hooks.find((hook) => hook.id === "pre:powershell:gateguard-fact-force"),
    ).toEqual({
      id: "pre:powershell:gateguard-fact-force",
      event: "PreToolUse",
      profiles: ["standard", "strict"],
      disableEligible: true,
    });
    const opencode = inventory.hooks.find((hook) => hook.id === "opencode:ecc-hooks");
    expect(opencode?.control).toEqual({ kind: "none" });
    expect(opencode?.declarations).toHaveLength(11);
    expect(new Set(opencode?.declarations?.map((declaration) => declaration.host))).toEqual(
      new Set(["opencode"]),
    );
  });

  it("carries no revision data: an inventory with another OpenCode row is accepted", () => {
    const descriptor = mutated((d) => {
      const hooks = d.sections.hookControlInventory.hooks as Record<string, unknown>[];
      hooks.push({
        id: "opencode:ecc-extra",
        event: "tool.execute.after",
        profiles: ["standard", "strict"],
        disableEligible: true,
        declarations: [
          {
            host: "opencode",
            sourcePath: ".opencode/plugins/ecc-hooks.ts",
            event: "tool.execute.after",
            execution: "in-process",
          },
        ],
        control: { kind: "none" },
      });
    });
    const inventory = readEccHookControlInventory(readEccDescriptor(descriptor));
    expect(inventory.hooks).toHaveLength(46);
  });

  it("refuses provenance whose content digest is not the digest of its own sources", () => {
    const descriptor = mutated((d) => {
      const provenance = d.sections.hookControlInventory.provenance as {
        sources: { sha256: string }[];
      };
      (provenance.sources[0] as { sha256: string }).sha256 = "0".repeat(64);
    });
    expect(() => readEccHookControlInventory(readEccDescriptor(descriptor))).toThrow(
      /is not the digest .* of its sources/,
    );
  });

  it("refuses a repeated id, an undeclared profile and a Claude switch on an ineligible row", () => {
    const hooks = (d: Doc) => d.sections.hookControlInventory.hooks as Record<string, unknown>[];
    const repeated = mutated((d) => {
      hooks(d).push({ ...(hooks(d)[1] as Record<string, unknown>) });
    });
    const undeclared = mutated((d) => {
      (hooks(d)[1] as { profiles: string[] }).profiles = ["paranoid"];
    });
    const switched = mutated((d) => {
      (hooks(d)[0] as Record<string, unknown>).control = { kind: "claude-settings-env" };
    });
    const read = (descriptor: ReturnType<typeof mutated>) => () =>
      readEccHookControlInventory(readEccDescriptor(descriptor));
    expect(read(repeated)).toThrow(/repeats/);
    expect(read(undeclared)).toThrow(/undeclared profile paranoid/);
    expect(read(switched)).toThrow(/Claude settings switch but is not a disable-eligible/);
  });
});
