/**
 * The new shell refuses an import over `MAX_IMPORT_BYTES` before reading it:
 * the refusal is announced as an error and no FileReader is constructed.
 */
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_BYTES } from "../../../src/org-policy/workbench/ui/shell/download-format.js";

// The shell modules are typed against the DOM lib, which the node test
// program does not load; import through a non-literal specifier so the
// typecheck scope stays unchanged, and describe the one call used here.
const fileTransferModule: string = "../../../src/org-policy/workbench/ui/shell/file-transfer.js";
const { mountFileTransfer } = (await import(fileTransferModule)) as {
  mountFileTransfer(options: unknown): { destroy(): void };
};

const windows: Window[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(windows.map((window) => window.happyDOM.close()));
  windows.length = 0;
});

function mount() {
  const window = new Window({ url: "http://localhost/" });
  windows.push(window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("Node", window.Node);
  const reads = vi.fn();
  vi.stubGlobal(
    "FileReader",
    class {
      constructor() {
        reads();
      }
      readAsText(): void {}
    },
  );
  const headerActions = window.document.createElement("div");
  window.document.body.append(headerActions);
  const announced: Array<readonly [string, boolean | undefined]> = [];
  const shell = {
    headerActions,
    announce: (message: string, isError?: boolean) => {
      announced.push([message, isError]);
    },
    router: { setScreen: () => true },
  };
  const session = {
    decision: () => null,
    validate: () => [],
    readinessBlockers: () => [],
  };
  mountFileTransfer({
    shell,
    session,
    decisionSchema: {},
    catalogValid: true,
    renderPreview: () => undefined,
  });
  const choose = (id: string, size: number) => {
    const input = window.document.getElementById(id);
    if (input === null) throw new Error(`expected #${id}`);
    Object.defineProperty(input, "files", { configurable: true, value: [{ size }] });
    input.dispatchEvent(new window.Event("change"));
  };
  return { announced, reads, choose };
}

describe("new shell import size limit", () => {
  it.each([
    ["policy-file", "Import rejected: file exceeds the 1 MiB limit."],
    ["evidence-file", "Import rejected: file exceeds the 1 MiB limit."],
    ["decision-file", "Decision import rejected: file exceeds the 1 MiB limit."],
  ])("refuses an oversized #%s before reading it", (id, message) => {
    const { announced, reads, choose } = mount();
    choose(id, MAX_IMPORT_BYTES + 1);
    expect(announced).toEqual([[message, true]]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("reads a policy file that is exactly at the limit", () => {
    const { announced, reads, choose } = mount();
    choose("policy-file", MAX_IMPORT_BYTES);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(announced).toEqual([]);
  });
});
