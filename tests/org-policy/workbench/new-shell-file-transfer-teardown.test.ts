/**
 * The new shell's file menu closes on an outside click through a document
 * listener; `destroy()` must remove that listener and the header controls.
 */
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  const headerActions = window.document.createElement("div");
  window.document.body.append(headerActions);
  const outside = window.document.createElement("p");
  window.document.body.append(outside);
  const shell = {
    headerActions,
    announce: () => undefined,
    router: { setScreen: () => true },
  };
  const session = {
    decision: () => null,
    validate: () => [],
    readinessBlockers: () => [],
  };
  const transfer = mountFileTransfer({
    shell,
    session,
    decisionSchema: {},
    catalogValid: true,
    renderPreview: () => undefined,
  });
  const menu = () => {
    const node = window.document.getElementById("wb-file-menu");
    if (node === null) throw new Error("expected #wb-file-menu");
    return node;
  };
  const clickOutside = () =>
    outside.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return { window, headerActions, transfer, menu, clickOutside };
}

describe("new shell file transfer teardown", () => {
  it("closes the open file menu on an outside click while mounted", () => {
    const { window, menu, clickOutside } = mount();
    window.document
      .getElementById("wb-file-menu-toggle")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(menu().hasAttribute("hidden")).toBe(false);
    clickOutside();
    expect(menu().hasAttribute("hidden")).toBe(true);
  });

  it("removes the document listener and the header controls on destroy", () => {
    const { headerActions, transfer, menu, clickOutside } = mount();
    const detached = menu();
    transfer.destroy();
    expect(headerActions.childElementCount).toBe(0);
    detached.removeAttribute("hidden");
    clickOutside();
    expect(detached.hasAttribute("hidden")).toBe(false);
  });
});
