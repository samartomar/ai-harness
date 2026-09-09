import { describe, expect, it } from "vitest";
import {
  type ClosureSeed,
  classificationOf,
  classifyClosure,
  type HostLoadFacts,
} from "../../src/binding/closure/profile-closure.js";

const host: HostLoadFacts = {
  hostVersion: "fixture-host@1",
  registersNestedSkillMd: false,
  readsNonSkillSkillFiles: false,
  probeEvidence: "test fixture only",
};
function classify(
  files: Record<string, string | undefined>,
  seeds: ClosureSeed[],
  facts: HostLoadFacts | undefined = host,
) {
  return classifyClosure(
    { files: Object.keys(files), readText: (path) => files[path] },
    { profile: "fixture:package", classifierVersion: 1, mode: "seeded", seeds },
    facts,
  );
}

describe("package and host-selected profile reachability", () => {
  it("carries package entry points, install scripts and transitive modules into the blocking closure", () => {
    const closure = classify(
      {
        "package.json": JSON.stringify({
          main: "lib/main.js",
          module: "lib/module.mjs",
          types: "lib/types.d.ts",
          bin: { package: "bin/run", unused: 42 },
          scripts: { postinstall: "node scripts/install.js", metadata: false },
        }),
        "lib/main.js": 'export { value } from "./shared"; const dep = require("external-package");',
        "lib/shared/index.ts": 'export { value } from "./missing";',
        "lib/module.mjs": "import(dynamicModule);",
        "lib/types.d.ts": "export interface Value {}",
        "bin/run": "#!/bin/sh\nsource ../lib/shell.sh\n",
        "lib/shell.sh": "printf ready",
        "scripts/install.js": "export const install = true;",
        "docs/unused.md": "Unreferenced documentation",
      },
      [{ path: "package.json", reachability: "control" }],
    );
    for (const path of [
      "lib/main.js",
      "lib/shared/index.ts",
      "lib/module.mjs",
      "lib/types.d.ts",
      "bin/run",
      "lib/shell.sh",
      "scripts/install.js",
    ]) {
      expect(classificationOf(closure, path), path).toEqual({
        classification: "closure",
        reachability: "control",
      });
    }
    expect(classificationOf(closure, "docs/unused.md").classification).toBe("materialized-inert");
    expect(closure.danglingRefs).toEqual(["./missing", "external-package"]);
    expect(closure.unresolvedRefs).toEqual(["import(dynamicModule)"]);
  });

  it("resolves a string bin from a nested package and preserves declared build reachability", () => {
    const closure = classify(
      {
        "nested/package.json": JSON.stringify({ bin: "./entry.cjs" }),
        "nested/entry.cjs": 'const value = require("./value.js");',
        "nested/value.mts": "export const value = 1;",
        "unselected.txt": "not imported",
      },
      [{ path: "nested/package.json", reachability: "build-input" }],
    );
    expect(classificationOf(closure, "nested/value.mts")).toEqual({
      classification: "closure",
      reachability: "build-input",
    });
    expect(closure.nodes.get("nested/entry.cjs")?.reachedBy).toEqual(["nested/package.json"]);
    expect(classificationOf(closure, "unselected.txt").classification).toBe("materialized-inert");
  });

  it("uses measured nested-skill loading facts for adjacent references and binds the result to the host", () => {
    const files = {
      "skills/review/SKILL.md":
        "Read [details](./sections/detail.md) and `./scripts/check.sh`. Use `review` as the command.",
      "skills/review/sections/detail.md": "Then consult [extra](./extra.md).",
      "skills/review/sections/extra.md": "Additional rules",
      "skills/review/scripts/check.sh": "printf ready",
      "skills/other/SKILL.md": undefined,
      "notes.txt": "unrelated",
    };
    const loadingHost = { ...host, registersNestedSkillMd: true, readsNonSkillSkillFiles: true };
    const loaded = classify(files, [], loadingHost);
    for (const path of Object.keys(files).filter((path) => path.startsWith("skills/"))) {
      expect(classificationOf(loaded, path), path).toEqual({
        classification: "closure",
        reachability: "model-loaded",
      });
    }
    expect(classificationOf(loaded, "notes.txt").classification).toBe("materialized-inert");
    const bodyOnly = classify(files, [], { ...loadingHost, readsNonSkillSkillFiles: false });
    expect(classificationOf(bodyOnly, "skills/review/SKILL.md").classification).toBe("closure");
    expect(classificationOf(bodyOnly, "skills/review/sections/detail.md").classification).toBe(
      "materialized-inert",
    );
    expect(bodyOnly.hostFactsDigest).not.toBe(loaded.hostFactsDigest);
    expect(bodyOnly.closureDigest).not.toBe(loaded.closureDigest);
    expect(classify(files, [], loadingHost).closureDigest).toBe(loaded.closureDigest);
  });

  it("widens only the literal dynamic directory while preserving stronger reached files and absent-seed diagnostics", () => {
    const closure = classify(
      {
        "entry.sh": "source scripts/$SELECTED\nexec $COMMAND\nsource scripts/known.sh\n",
        "scripts/known.sh": "printf ready",
        "scripts/possible.sh": "unresolved candidate",
        "scripts-neighbor/other.sh": "not in the referenced directory",
      },
      [
        { path: "entry.sh", reachability: "control" },
        { path: "absent.sh", reachability: "control" },
      ],
    );
    expect(classificationOf(closure, "scripts/known.sh").reachability).toBe("control");
    expect(classificationOf(closure, "scripts/possible.sh")).toEqual({
      classification: "closure",
      reachability: "unknown",
    });
    expect(classificationOf(closure, "scripts-neighbor/other.sh").classification).toBe(
      "materialized-inert",
    );
    expect(closure.unresolvedRefs).toEqual(["$COMMAND", "scripts/$SELECTED"]);
    expect(closure.danglingRefs).toEqual(["absent.sh"]);
  });
});
