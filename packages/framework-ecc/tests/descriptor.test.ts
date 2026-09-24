import { describe, expect, it } from "vitest";
import { readEccDescriptor, readEccHookControlInventory } from "../src/descriptor.js";
import {
  CATALOG_DESCRIPTOR_SHA256,
  descriptorFromDocument,
  descriptorOf,
  fixtureDescriptorBytes,
  fixtureDescriptorDocument,
  PINNED_COMMIT,
} from "./context.js";

type Section = Record<string, unknown>;
type Doc = {
  sections: { vendorLock: Section; hookControlInventory: Section };
} & Record<string, unknown>;

function mutated(change: (document: Doc) => void) {
  const document = fixtureDescriptorDocument() as Doc;
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
    expect(() => readEccDescriptor(descriptor)).toThrow(/supports affaan-m\/ECC@5caf398a/);
  });
});

describe("readEccHookControlInventory", () => {
  it("reads the reviewed 43-row inventory and ECC's three profiles", () => {
    const inventory = readEccHookControlInventory(
      readEccDescriptor(descriptorOf(fixtureDescriptorBytes())),
    );
    expect(inventory.hooks).toHaveLength(43);
    expect(inventory.profiles.map((profile) => profile.id)).toEqual([
      "minimal",
      "standard",
      "strict",
    ]);
    expect(inventory.hooks.filter((hook) => hook.disableEligible)).toHaveLength(42);
  });

  it("refuses an inventory whose rows no longer match the reviewed eligibility", () => {
    const descriptor = mutated((d) => {
      const hooks = d.sections.hookControlInventory.hooks as { disableEligible: boolean }[];
      const first = hooks[0] as { disableEligible: boolean };
      first.disableEligible = !first.disableEligible;
    });
    expect(() => readEccHookControlInventory(readEccDescriptor(descriptor))).toThrow(
      /43 distinct rows, 42 disable-eligible ids/,
    );
  });

  it("refuses hook provenance that is not the reviewed source content", () => {
    const descriptor = mutated((d) => {
      const provenance = d.sections.hookControlInventory.provenance as {
        sources: { sha256: string }[];
      };
      (provenance.sources[0] as { sha256: string }).sha256 = "0".repeat(64);
    });
    expect(() => readEccHookControlInventory(readEccDescriptor(descriptor))).toThrow(
      /is not the reviewed inventory/,
    );
  });
});
