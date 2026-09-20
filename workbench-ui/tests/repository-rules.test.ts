// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The delivery contract's dependency allow-list: development-only, pinned, bundled into the page. */
const ALLOW_LIST = [
  "react",
  "react-dom",
  "@types/react",
  "@types/react-dom",
  "vite",
  "@vitejs/plugin-react",
  "@testing-library/react",
  "@testing-library/dom",
  "@testing-library/user-event",
  "@radix-ui/react-dialog",
];

/** A package of these families outside the allow-list is a contract change. */
const UI_FAMILIES =
  /^(react($|-)|@types\/react|@radix-ui\/|@testing-library\/|@vitejs\/|vite$|vite-)/u;

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("component UI repository rules", () => {
  it("declares every allow-listed package as a development dependency at an exact version", () => {
    const development = manifest.devDependencies ?? {};
    const loose = ALLOW_LIST.filter(
      (name) => !/^\d+\.\d+\.\d+$/u.test(development[name] ?? "missing"),
    );
    expect(loose).toEqual([]);
  });

  it("declares no UI-family package outside the allow-list, and none as a runtime dependency", () => {
    const allowed = new Set(ALLOW_LIST);
    const extra = Object.keys(manifest.devDependencies ?? {}).filter(
      (name) => UI_FAMILIES.test(name) && !allowed.has(name),
    );
    const runtime = Object.keys(manifest.dependencies ?? {}).filter(
      (name) => UI_FAMILIES.test(name) || allowed.has(name),
    );
    expect({ extra, runtime }).toEqual({ extra: [], runtime: [] });
  });

  it("tracks no generated file of the component UI", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "workbench-ui"], { encoding: "utf8" })
      .split("\n")
      .filter((path) => path.length > 0);
    expect(tracked.length).toBeGreaterThan(0);
    expect(
      tracked.filter(
        (path) =>
          path.startsWith("workbench-ui/dist/") ||
          path.includes("/node_modules/") ||
          /\.generated\.|\.tsbuildinfo$/u.test(path),
      ),
    ).toEqual([]);
    expect(readFileSync(".gitignore", "utf8")).toContain("/workbench-ui/dist/");
  });
});
