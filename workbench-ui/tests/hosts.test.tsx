import { beforeEach, describe, expect, it } from "vitest";
import { readEmbeddedInput } from "../hosts/shared.js";

/**
 * The offline file's embedded input. Anything but a valid, current input
 * refuses: the engine's message is rendered as text and nothing is mounted.
 */

function pageWith(scriptText: string | undefined): Document {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  if (scriptText !== undefined) {
    const script = document.createElement("script");
    script.id = "aih-workbench-input";
    script.type = "application/json";
    script.textContent = scriptText;
    document.body.append(script);
  }
  return document;
}

function rootText(): string {
  return document.getElementById("root")?.textContent ?? "";
}

function rootMarkup(): string {
  return document.getElementById("root")?.innerHTML ?? "";
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the embedded page input", () => {
  it("accepts a current input and leaves the page for the app to mount", () => {
    const input = { format: "aih-workbench-input", version: 1, door: "user", model: { a: 1 } };
    const parsed = readEmbeddedInput(pageWith(JSON.stringify(input)));
    expect(parsed).toEqual(input);
    expect(rootText()).toBe("");
  });

  it("refuses a page with no input element", () => {
    expect(readEmbeddedInput(pageWith(undefined))).toBeUndefined();
    expect(rootText()).toBe("This page carries no Workbench input.");
  });

  it("refuses an input that is not strict JSON", () => {
    expect(readEmbeddedInput(pageWith("{not json}"))).toBeUndefined();
    expect(rootText()).toBe("The Workbench input on this page is not strict JSON.");
  });

  it("refuses an unknown version with the engine's message", () => {
    const input = { format: "aih-workbench-input", version: 2, door: "admin", model: {} };
    expect(readEmbeddedInput(pageWith(JSON.stringify(input)))).toBeUndefined();
    expect(rootText()).toBe("The page input is version 2. This page supports version 1.");
  });

  it("refuses an unknown door", () => {
    const input = { format: "aih-workbench-input", version: 1, door: "root", model: {} };
    expect(readEmbeddedInput(pageWith(JSON.stringify(input)))).toBeUndefined();
    expect(rootText()).toBe("The page input door must be one of admin, user, chooser.");
  });

  it("renders a hostile message as text, never as markup", () => {
    const input = {
      format: "aih-workbench-input",
      version: 1,
      door: "<img src=x onerror=alert(1)>",
      model: {},
    };
    expect(readEmbeddedInput(pageWith(JSON.stringify(input)))).toBeUndefined();
    expect(rootMarkup()).not.toContain("<img");
    expect(rootText()).toContain("door must be one of");
  });
});
