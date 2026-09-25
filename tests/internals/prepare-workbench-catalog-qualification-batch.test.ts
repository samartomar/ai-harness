import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Artifact verification itself is covered by the catalog-qualification tests; here it is
 * replaced by a recording stand-in so the single and the batch mode can be compared over
 * several entries, call for call and byte for byte.
 */
const verification = vi.hoisted(() => ({
  calls: [] as { mode: string; bundle: unknown; bindings: unknown; records: unknown }[],
  mode: "",
  bindingCalls: [] as unknown[][],
}));

vi.mock("../../src/org-policy/workbench/prepared-catalog.js", () => ({
  defaultPreparedWorkbenchCatalog: () => ({ bundle: { fixture: "installed authoring bundle" } }),
}));

vi.mock("../../src/org-policy/supported-qualification-receipt-v2.js", () => ({
  parseAihSupportedQualificationReceiptV2Bytes: (bytes: Uint8Array) => {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as { entryId?: unknown };
    return typeof value.entryId === "string" ? { entryId: value.entryId } : undefined;
  },
}));

vi.mock("../../src/org-policy/workbench/core/catalog-qualification-v1.js", () => ({
  prepareRegisteredCompilerQualificationBindingsV1: (...input: unknown[]) => {
    verification.bindingCalls.push(input);
    return Object.fromEntries(
      ["entry.a", "entry.b", "entry.c"].map((id) => [
        `asset/${id}`,
        { asset: { assetId: `asset/${id}` }, provider: input[2] },
      ]),
    );
  },
  verifyCatalogQualificationArtifactsForPackagingV1: async (
    bundle: unknown,
    bindings: unknown,
    records: { memberBytes: Uint8Array; publisher: { subjectName: string } }[],
  ) => {
    verification.calls.push({ mode: verification.mode, bundle, bindings, records });
    if (Buffer.from(records[0]?.memberBytes ?? []).includes("unverifiable"))
      throw new TypeError("Catalog qualification artifacts failed verification (fixture).");
    return { entryId: records[0]?.publisher.subjectName.replace(/\.json$/u, "") };
  },
  catalogQualificationPackagedProjectionV1: (prepared: { entryId: string }) => ({
    summary: { [`asset/${prepared.entryId}`]: { entryId: prepared.entryId, state: "qualified" } },
  }),
}));

const { prepareWorkbenchCatalogQualificationCommandV1 } = await import(
  "../../src/internals/prepare-workbench-catalog-qualification.js"
);

const roots: string[] = [];
beforeEach(() => {
  verification.calls.length = 0;
  verification.bindingCalls.length = 0;
  verification.mode = "";
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-catalog-qualification-batch-"));
  roots.push(root);
  return root;
}

function entry(root: string, name: string, overrides: Record<string, string> = {}): string {
  const directory = join(root, name);
  mkdirSync(directory);
  const files = {
    "receipt.json": JSON.stringify({ entryId: name }),
    "receipt-set.json": JSON.stringify({ set: "fixture" }),
    "member.json": JSON.stringify({ closure: { identity: `artifact:closures/${name}.json` } }),
    "closure.json": JSON.stringify({ closure: name }),
    ...overrides,
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
  return directory;
}

function layout(names = ["entry.a", "entry.b", "entry.c"]) {
  const work = temporary();
  const artifacts = join(work, "artifacts");
  mkdirSync(artifacts);
  for (const name of names) entry(artifacts, name);
  return { work, artifacts, source: join(work, "source"), output: join(work, "out") };
}

const batch = (source: string, artifacts: string, output: string) => [
  "--source",
  source,
  "--provider",
  "mattpocock",
  "--artifacts-root",
  artifacts,
  "--output-dir",
  output,
];

describe("prepare-workbench-catalog-qualification batch mode", () => {
  it("verifies every entry as the single mode does and writes the single mode's bytes", async () => {
    const { work, artifacts, source, output } = layout();
    const single = join(work, "single");
    mkdirSync(single);
    verification.mode = "single";
    for (const name of ["entry.a", "entry.b", "entry.c"])
      await prepareWorkbenchCatalogQualificationCommandV1([
        "--source",
        source,
        "--provider",
        "mattpocock",
        "--artifacts",
        join(artifacts, name),
        "--output",
        join(single, `${name}.json`),
      ]);
    verification.mode = "batch";
    const message = await prepareWorkbenchCatalogQualificationCommandV1(
      batch(source, artifacts, output),
    );
    expect(message).toMatch(/3 entries/u);

    expect(readdirSync(output).sort()).toEqual(["entry.a.json", "entry.b.json", "entry.c.json"]);
    for (const name of ["entry.a", "entry.b", "entry.c"]) {
      const written = readFileSync(join(output, `${name}.json`));
      expect(written.equals(readFileSync(join(single, `${name}.json`)))).toBe(true);
      expect(JSON.parse(written.toString("utf8")).projections).toEqual([
        { [`asset/${name}`]: { entryId: name, state: "qualified" } },
      ]);
    }
    const byMode = (mode: string) =>
      verification.calls
        .filter((call) => call.mode === mode)
        .map(({ bundle, bindings, records }) => ({ bundle, bindings, records }));
    expect(byMode("batch")).toHaveLength(3);
    expect(byMode("batch")).toEqual(byMode("single"));
    expect(verification.bindingCalls).toHaveLength(6);
    for (const call of verification.bindingCalls)
      expect(call.slice(1)).toEqual([source, "mattpocock"]);
  });

  it("writes nothing unless every entry verifies", async () => {
    const { artifacts, source, output } = layout(["entry.a", "entry.c"]);
    entry(artifacts, "entry.b", {
      "member.json": JSON.stringify({
        closure: { identity: "artifact:closures/entry.b.json" },
        note: "unverifiable",
      }),
    });
    await expect(
      prepareWorkbenchCatalogQualificationCommandV1(batch(source, artifacts, output)),
    ).rejects.toThrow(/failed verification/u);
    expect(verification.calls.map((call) => call.records)).toHaveLength(2);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses an entry directory whose receipt names another entry", async () => {
    const { artifacts, source, output } = layout(["entry.a"]);
    entry(artifacts, "entry.b", { "receipt.json": JSON.stringify({ entryId: "entry.c" }) });
    await expect(
      prepareWorkbenchCatalogQualificationCommandV1(batch(source, artifacts, output)),
    ).rejects.toThrow(/entry\.b holds the receipt of entry\.c/u);
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    [
      "an extra file in an entry",
      (artifacts: string) => writeFileSync(join(artifacts, "entry.a", "notes.txt"), "x"),
      /entry\.a must hold exactly closure\.json, member\.json, receipt-set\.json and receipt\.json/u,
    ],
    [
      "a missing file in an entry",
      (artifacts: string) => rmSync(join(artifacts, "entry.b", "closure.json")),
      /entry\.b must hold exactly/u,
    ],
    [
      "a file beside the entry directories",
      (artifacts: string) => writeFileSync(join(artifacts, "README.md"), "x"),
      /README\.md, which is not an entry directory/u,
    ],
  ])("refuses %s before verifying anything", async (_label, damage, reason) => {
    const { artifacts, source, output } = layout();
    damage(artifacts);
    await expect(
      prepareWorkbenchCatalogQualificationCommandV1(batch(source, artifacts, output)),
    ).rejects.toThrow(reason);
    expect(verification.calls).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses a linked entry directory", async () => {
    const { work, artifacts, source, output } = layout(["entry.a"]);
    const elsewhere = join(work, "elsewhere");
    mkdirSync(elsewhere);
    entry(elsewhere, "entry.b");
    try {
      symlinkSync(join(elsewhere, "entry.b"), join(artifacts, "entry.b"), "junction");
    } catch {
      return; // This host cannot link directories; the file cases cover the rule.
    }
    await expect(
      prepareWorkbenchCatalogQualificationCommandV1(batch(source, artifacts, output)),
    ).rejects.toThrow(/entry\.b, which is not an entry directory/u);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses an artifacts root without entries", async () => {
    const { artifacts, source, output } = layout([]);
    await expect(
      prepareWorkbenchCatalogQualificationCommandV1(batch(source, artifacts, output)),
    ).rejects.toThrow(/holds no entry directories/u);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses an existing output directory before reading any artifact", async () => {
    const { artifacts, source, output } = layout();
    mkdirSync(output);
    writeFileSync(join(output, "keep.json"), "keep");
    await expect(
      prepareWorkbenchCatalogQualificationCommandV1(batch(source, artifacts, output)),
    ).rejects.toThrow(/EEXIST/u);
    expect(readdirSync(output)).toEqual(["keep.json"]);
    expect(verification.calls).toHaveLength(0);
  });

  it.each([
    [["--source", "a", "--provider", "p", "--artifacts-root", "b"]],
    [["--source", "a", "--provider", "p", "--artifacts-root", "b", "--output", "c"]],
    [["--source", "a", "--provider", "p", "--artifacts", "b", "--output-dir", "c"]],
    [["--provider", "p", "--source", "a", "--artifacts-root", "b", "--output-dir", "c"]],
    [["--source", "a", "--provider", "p", "--artifacts-root", "b", "--output-dir", "--x"]],
    [
      [
        "--source",
        "a",
        "--provider",
        "p",
        "--artifacts-root",
        "b",
        "--output-dir",
        "c",
        "--candidate-catalog",
        "d",
        "--candidate-catalog-sha256",
        "ABC",
      ],
    ],
  ])("rejects anything but the batch flags in order: %j", async (argv) => {
    await expect(prepareWorkbenchCatalogQualificationCommandV1(argv)).rejects.toThrow(
      /^Usage: prepare-workbench-catalog-qualification/u,
    );
  });
});
