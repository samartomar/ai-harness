import { readFileSync, writeFileSync } from "node:fs";
import { Window } from "happy-dom";

function input(window, id) {
  const element = window.document.getElementById(id);
  if (!element || !("value" in element)) throw new Error(`packed-workbench-missing-field:${id}`);
  return element;
}

function setFields(window, fields) {
  for (const [id, value] of Object.entries(fields)) {
    const element = input(window, id);
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
}

async function waitForWorkbench(window, action) {
  window.__aihPolicyWorkbenchPending = undefined;
  action();
  const pending = window.__aihPolicyWorkbenchPending;
  if (!pending || typeof pending.then !== "function") {
    const fieldErrors = [...window.document.querySelectorAll(".field-error:not([hidden])")]
      .map((node) => `${node.id}:${node.textContent}`)
      .join("|");
    throw new Error(
      `packed-workbench-action-refused:${fieldErrors || (window.document.getElementById("announcement")?.textContent ?? "unknown")}`,
    );
  }
  await pending;
}

/**
 * Executes the exact portable Workbench emitted by a packed CLI, captures its
 * browser download, and writes those downloaded bytes into the disposable
 * administrator root used by a cold proof.
 */
export async function authorProtectedPolicyViaPackedWorkbench({
  htmlPath,
  outputPath,
  authorityFields,
  decisions,
  revokeDecisionIndexes = [],
}) {
  const html = readFileSync(htmlPath, "utf8");
  const window = new Window({ url: "http://localhost/aih-policy-workbench.html" });
  window.document.write(html);
  window.structuredClone = structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/giu)].map(
    (match) => match[1],
  );
  if (scripts.length === 0) throw new Error("packed-workbench-script-missing");
  window.eval(scripts.join("\n"));

  const enterprise = window.document.querySelector('[data-preset="enterprise"]');
  if (!enterprise) throw new Error("packed-workbench-enterprise-preset-missing");
  enterprise.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const form = window.document.getElementById("protected-form");
  if (!form) throw new Error("packed-workbench-protected-form-missing");
  if (form.querySelectorAll("textarea:not([readonly])").length !== 0)
    throw new Error("packed-workbench-raw-json-authoring-exposed");

  for (const decisionFields of decisions) {
    setFields(window, { ...authorityFields, ...decisionFields });
    await waitForWorkbench(window, () =>
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
  }

  for (const index of revokeDecisionIndexes) {
    const button = window.document.querySelector(`[data-protected-revoke="${String(index)}"]`);
    if (!button) throw new Error(`packed-workbench-revocation-row-missing:${String(index)}`);
    await waitForWorkbench(window, () =>
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    );
  }

  let downloadedBlob;
  let downloadedName;
  window.URL.createObjectURL = (blob) => {
    downloadedBlob = blob;
    return "blob:aih-policy-bundle";
  };
  window.URL.revokeObjectURL = () => undefined;
  window.HTMLAnchorElement.prototype.click = function click() {
    downloadedName = this.download;
  };
  await waitForWorkbench(window, () =>
    window.document
      .getElementById("download-protected-bundle")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  );
  if (downloadedName !== "aih-policy-bundle.json" || downloadedBlob === undefined)
    throw new Error("packed-workbench-download-missing");
  const downloadedText = await downloadedBlob.text();
  const preview = input(window, "protected-bundle-preview").value;
  if (downloadedText !== preview) throw new Error("packed-workbench-download-preview-mismatch");
  const bundle = JSON.parse(downloadedText);
  writeFileSync(outputPath, downloadedText);
  window.close();
  return bundle;
}
