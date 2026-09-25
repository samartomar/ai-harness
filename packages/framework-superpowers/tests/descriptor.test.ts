import { createHash } from "node:crypto";
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
  PINNED_COMMIT,
  PINNED_SECTION_FIXTURE,
  pinnedDescriptor,
  pinnedDescriptorDocument,
  pinnedSectionBytes,
} from "./context.js";

type Json = Record<string, unknown>;

function withSections(mutate: (sections: Json) => void): Json {
  const document = pinnedDescriptorDocument() as unknown as Json;
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

  it("accepts a descriptor carrying Catalog's hook inventory produced at the pinned commit", () => {
    const digest = createHash("sha256").update(pinnedSectionBytes()).digest("hex");
    expect(digest).toBe(PINNED_SECTION_FIXTURE.sha256);
    const descriptor = readSuperpowersDescriptor(pinnedDescriptor());
    expect(descriptor.source).toEqual({
      owner: "obra",
      repo: "Superpowers",
      commit: PINNED_COMMIT,
    });
    expect(descriptor.components).toEqual([
      {
        id: "runtime:superpowers-plugin",
        paths: [
          ".cursor-plugin",
          ".devin-plugin",
          ".hermes-plugin",
          ".kimi-plugin",
          ".muse-plugin",
          ".opencode",
          "hooks",
          "index.js",
        ],
      },
    ]);
  });

  it("ignores sections it does not read", () => {
    const document = withSections((sections) => {
      sections.contentMetadata = { version: 1 };
    });
    expect(readSuperpowersDescriptor(descriptorFromDocument(document)).components).toHaveLength(1);
  });

  const refusals: ReadonlyArray<readonly [string, () => Json]> = [
    [
      "another format",
      () => ({ ...(pinnedDescriptorDocument() as unknown as Json), format: "aih-catalog-index" }),
    ],
    ["another version", () => ({ ...(pinnedDescriptorDocument() as unknown as Json), version: 2 })],
    [
      "another framework",
      () => ({ ...(pinnedDescriptorDocument() as unknown as Json), frameworkId: "ecc" }),
    ],
    [
      "an extra top-level key",
      () => ({ ...(pinnedDescriptorDocument() as unknown as Json), extra: true }),
    ],
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
          (components[0] as Json).paths = ["../outside"];
        }),
    ],
    [
      "an absolute component path",
      () =>
        withSections((sections) => {
          const components = (sections.vendorLock as Json).components as Json[];
          (components[0] as Json).paths = ["/etc"];
        }),
    ],
    [
      "a Windows component path",
      () =>
        withSections((sections) => {
          const components = (sections.vendorLock as Json).components as Json[];
          (components[0] as Json).paths = ["skills\\brainstorming"];
        }),
    ],
    [
      "a duplicate component id",
      () =>
        withSections((sections) => {
          const lock = sections.vendorLock as Json;
          const components = lock.components as Json[];
          lock.components = [...components, components[0]];
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
  it("reads the five hooks Catalog recorded from the pinned tree", () => {
    const inventory = readSuperpowersHookInventory(readSuperpowersDescriptor(pinnedDescriptor()));
    expect(inventory.upstream).toEqual({ repository: "obra/Superpowers", commit: PINNED_COMMIT });
    expect(inventory.hooks.map((hook) => [hook.id, hook.event])).toEqual([
      ["hook:session-start", "SessionStart"],
      ["hook:skills-path", "config"],
      ["hook:skill-registration", "setup"],
      ["hook:session-context", "context"],
      ["hook:first-turn-context", "pre_llm_call"],
    ]);
    expect(inventory.hooks.every((hook) => hook.upstreamControl.kind === "none")).toBe(true);
    const [start] = inventory.hooks;
    expect(start?.declarations.map((declaration) => declaration.host)).toEqual([
      "claude",
      "copilot",
      "antigravity",
      "cursor",
      "kimi",
      "muse",
      "opencode",
    ]);
  });

  it("reads the Muse and Hermes declarations as unenforced rows and Devin as a recorded source only", () => {
    const inventory = readSuperpowersHookInventory(readSuperpowersDescriptor(pinnedDescriptor()));
    const declarations = inventory.hooks.flatMap((hook) =>
      hook.declarations.map((declaration) => ({ hookId: hook.id, ...declaration })),
    );
    const muse = declarations.find((declaration) => declaration.host === "muse");
    expect(muse).toMatchObject({
      hookId: "hook:session-start",
      sourcePath: ".muse-plugin/plugin.json",
      event: "SessionStart",
      command: "sh hooks/session-start",
      execution: "process",
      hostControl: { kind: "none", enforcement: "unenforced" },
    });
    expect(muse?.hostControl?.nextRoute).toMatch(/muse's own/);
    const hermes = declarations.find((declaration) => declaration.host === "hermes");
    expect(hermes).toMatchObject({
      hookId: "hook:first-turn-context",
      sourcePath: ".hermes-plugin/__init__.py",
      event: "pre_llm_call",
      execution: "in-process",
      hostControl: { kind: "none", enforcement: "unenforced" },
    });
    expect(hermes?.hostControl?.nextRoute).toMatch(/hermes's own/);
    // Devin's manifest declares no hook at the pinned commit: Catalog records
    // the file's digest as a source, and there is no Devin row to label.
    expect(declarations.some((declaration) => declaration.host === "devin")).toBe(false);
    const document = pinnedDescriptorDocument();
    const provenance = document.sections.hookControlInventory.provenance as {
      sources: Array<{ path: string }>;
    };
    expect(provenance.sources.map((source) => source.path)).toContain(".devin-plugin/plugin.json");
    const controlled = declarations.filter(
      (declaration) => declaration.host !== "muse" && declaration.host !== "hermes",
    );
    expect(controlled.every((declaration) => declaration.hostControl === undefined)).toBe(true);
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
      "a hook event outside the event grammar",
      (inventory) => {
        const hooks = inventory.hooks as Json[];
        (hooks[0] as Json).event = "pre-llm call";
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
