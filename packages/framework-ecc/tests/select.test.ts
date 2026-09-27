import type { RepoStack } from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
import { eccLanguages } from "../src/ecc/select.js";

function stack(languages: string[], frameworks: string[], deployment: string[] = []): RepoStack {
  return { languages, frameworks, deployment } as RepoStack;
}

describe("ECC language guidance selection", () => {
  it("keeps a new repository scoped until its stack is known", () => {
    expect(eccLanguages(stack([], []))).toEqual({ packs: [], installEverything: false });
    expect(eccLanguages(stack([], [], ["Docker"]))).toEqual({
      packs: [],
      installEverything: false,
    });
  });

  it("maps detected languages and web frameworks to pinned pack order", () => {
    expect(
      eccLanguages(
        stack(
          ["JavaScript/Node.js", "TypeScript/Node.js", "Python", "Go", "Swift", "PHP", "Ruby"],
          ["Angular", "Vue", "Nuxt", "Next.js", "React", "Svelte"],
        ),
      ),
    ).toEqual({
      packs: [
        "typescript",
        "python",
        "golang",
        "swift",
        "php",
        "ruby",
        "web",
        "angular",
        "vue",
        "nuxt",
      ],
      installEverything: false,
    });
  });

  it("omits languages without a dedicated ECC pack", () => {
    expect(eccLanguages(stack(["Rust", "Java", ".NET"], ["Django"]))).toEqual({
      packs: [],
      installEverything: false,
    });
  });
});
