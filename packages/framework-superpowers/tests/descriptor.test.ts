import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTOR_BYTES,
  readSuperpowersDescriptor,
  readSuperpowersHookInventory,
} from "../src/descriptor.js";
import {
  descriptorFromDocument,
  descriptorOf,
  fixtureDescriptorBytes,
  fixtureDescriptorDocument,
  PINNED_COMMIT,
} from "./context.js";

type Json = Record<string, unknown>;

function withSections(mutate: (sections: Json) => void): Json {
  const document = fixtureDescriptorDocument();
  mutate(document.sections as Json);
  return document;
}

function vendorLockOf(document: Json): Json {
  return (document.sections as Json).vendorLock as Json;
}

function refusalOf(run: () => unknown): { code: unknown; message: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("readSuperpowersDescriptor", () => {
  it("reads the exact pinned source and its components from Catalog's bytes", () => {
    const descriptor = readSuperpowersDescriptor(descriptorOf(fixtureDescriptorBytes()));
    expect(descriptor.source).toEqual({
      owner: "obra",
      repo: "Superpowers",
      commit: PINNED_COMMIT,
    });
    expect(descriptor.components).toHaveLength(15);
    expect(descriptor.components[0]).toEqual({
      id: "runtime:superpowers-plugin",
      paths: [
        ".claude-plugin",
        ".codex-plugin",
        ".cursor-plugin",
        ".kimi-plugin",
        ".opencode",
        ".pi",
        "gemini-extension.json",
        "hooks",
        "package.json",
        "scripts",
      ],
    });
    expect(descriptor.components[1]).toEqual({
      id: "skill:brainstorming",
      paths: ["skills/brainstorming"],
      skillContent: true,
    });
  });

  it("ignores sections it does not read", () => {
    const document = withSections((sections) => {
      sections.contentMetadata = { version: 1 };
    });
    expect(readSuperpowersDescriptor(descriptorFromDocument(document)).components).toHaveLength(15);
  });

  const refusals: ReadonlyArray<readonly [string, () => Json]> = [
    ["another format", () => ({ ...fixtureDescriptorDocument(), format: "aih-catalog-index" })],
    ["another version", () => ({ ...fixtureDescriptorDocument(), version: 2 })],
    ["another framework", () => ({ ...fixtureDescriptorDocument(), frameworkId: "ecc" })],
    ["an extra top-level key", () => ({ ...fixtureDescriptorDocument(), extra: true })],
    ["no vendorLock section", () => withSections((sections) => delete sections.vendorLock)],
    [
      "another source id",
      () => withSections((sections) => ((sections.vendorLock as Json).id = "ecc")),
    ],
    [
      "a pin the plugin was not built for",
      () => withSections((sections) => ((sections.vendorLock as Json).pinnedSha = "c".repeat(40))),
    ],
    [
      "a component path that escapes the source",
      () =>
        withSections((sections) => {
          const components = (sections.vendorLock as Json).components as Json[];
          (components[1] as Json).paths = ["../outside"];
        }),
    ],
    [
      "an absolute component path",
      () =>
        withSections((sections) => {
          const components = (sections.vendorLock as Json).components as Json[];
          (components[1] as Json).paths = ["/etc"];
        }),
    ],
    [
      "a Windows component path",
      () =>
        withSections((sections) => {
          const components = (sections.vendorLock as Json).components as Json[];
          (components[1] as Json).paths = ["skills\\brainstorming"];
        }),
    ],
    [
      "a duplicate component id",
      () =>
        withSections((sections) => {
          const lock = sections.vendorLock as Json;
          const components = lock.components as Json[];
          lock.components = [...components, components[1]];
        }),
    ],
    [
      "no components",
      () => withSections((sections) => ((sections.vendorLock as Json).components = [])),
    ],
  ];

  it.each(refusals)("refuses %s", (_label, build) => {
    const refusal = refusalOf(() => readSuperpowersDescriptor(descriptorFromDocument(build())));
    expect(refusal.code).toBe("AIH_FRAMEWORK_DESCRIPTOR");
    expect(refusal.message).toMatch(/^superpowers descriptor refused: /);
  });

  it("refuses bytes whose digest does not match what Core loaded", () => {
    const descriptor = { ...descriptorOf(fixtureDescriptorBytes()), sha256: "0".repeat(64) };
    expect(refusalOf(() => readSuperpowersDescriptor(descriptor)).message).toContain("digest");
  });

  it("refuses descriptor bytes for another framework id", () => {
    const descriptor = { ...descriptorOf(fixtureDescriptorBytes()), frameworkId: "ecc" as const };
    expect(refusalOf(() => readSuperpowersDescriptor(descriptor)).code).toBe(
      "AIH_FRAMEWORK_DESCRIPTOR",
    );
  });

  it("refuses duplicate JSON keys instead of keeping the last one", () => {
    const text = new TextDecoder().decode(fixtureDescriptorBytes());
    const doubled = text.replace('{"format":', '{"version":1,"format":');
    const refusal = refusalOf(() =>
      readSuperpowersDescriptor(descriptorOf(new TextEncoder().encode(doubled))),
    );
    expect(refusal.message).toContain("duplicate JSON object key");
  });

  it("refuses oversize bytes before parsing", () => {
    const refusal = refusalOf(() =>
      readSuperpowersDescriptor(descriptorOf(new Uint8Array(MAX_DESCRIPTOR_BYTES + 1))),
    );
    expect(refusal.message).toContain("exceeds");
  });

  it("names the pin the plugin supports when Catalog carries another", () => {
    const document = withSections(
      (sections) => ((sections.vendorLock as Json).pinnedSha = "c".repeat(40)),
    );
    const refusal = refusalOf(() => readSuperpowersDescriptor(descriptorFromDocument(document)));
    expect(refusal.message).toContain(`obra/Superpowers@${"c".repeat(40)}`);
    expect(refusal.message).toContain(PINNED_COMMIT);
    expect(vendorLockOf(document).pinnedSha).toBe("c".repeat(40));
  });
});

describe("readSuperpowersHookInventory", () => {
  it("reads the SessionStart hook recorded from the pinned tree", () => {
    const inventory = readSuperpowersHookInventory(
      readSuperpowersDescriptor(descriptorOf(fixtureDescriptorBytes())),
    );
    expect(inventory.upstream).toEqual({ repository: "obra/Superpowers", commit: PINNED_COMMIT });
    expect(inventory.hooks.map((hook) => hook.id)).toEqual(["hook:session-start"]);
    const [hook] = inventory.hooks;
    expect(hook?.upstreamControl).toEqual({ kind: "none" });
    expect(hook?.declarations.map((declaration) => declaration.host)).toEqual([
      "claude",
      "copilot",
      "antigravity",
      "cursor",
      "kimi",
      "opencode",
    ]);
  });

  const inventoryRefusals: ReadonlyArray<readonly [string, (inventory: Json) => void]> = [
    ["a missing section", () => undefined],
    [
      "a provenance commit other than the pin",
      (inventory) => ((inventory.provenance as Json).commit = "c".repeat(40)),
    ],
    [
      "a declaration from a file without a recorded digest",
      (inventory) => {
        const hooks = inventory.hooks as Json[];
        const declarations = (hooks[0] as Json).declarations as Json[];
        (declarations[0] as Json).sourcePath = "hooks/other.json";
      },
    ],
    [
      "an upstream switch this plugin does not know",
      (inventory) => {
        const hooks = inventory.hooks as Json[];
        (hooks[0] as Json).upstreamControl = { kind: "environment", name: "X", value: "1" };
      },
    ],
    [
      // A well-formed host aih does not control is accepted (hostControl none);
      // a malformed host id is not.
      "a malformed host id",
      (inventory) => {
        const hooks = inventory.hooks as Json[];
        const declarations = (hooks[0] as Json).declarations as Json[];
        (declarations[0] as Json).host = "Notepad!";
      },
    ],
    [
      "an unknown key",
      (inventory) => {
        const hooks = inventory.hooks as Json[];
        (hooks[0] as Json).extra = true;
      },
    ],
  ];

  it.each(inventoryRefusals)("refuses %s", (label, mutate) => {
    const document = withSections((sections) => {
      if (label === "a missing section") delete sections.hookControlInventory;
      else mutate(sections.hookControlInventory as Json);
    });
    const descriptor = readSuperpowersDescriptor(descriptorFromDocument(document));
    const refusal = refusalOf(() => readSuperpowersHookInventory(descriptor));
    expect(refusal.code).toBe("AIH_FRAMEWORK_DESCRIPTOR");
  });
});
