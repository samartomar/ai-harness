import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

/** Exercise only the packed Workbench's public controls and downloaded policy. */
export async function authorMcpPolicyViaPackedWorkbench({
  htmlPath,
  targets,
  servers,
  authorityFields,
}) {
  const html = readFileSync(htmlPath, "utf8");
  const window = new Window({ url: "http://localhost/aih-policy-workbench.html" });
  try {
    window.document.write(html);
    window.structuredClone = structuredClone;
    window.eval(
      [...html.matchAll(/<script>([\s\S]*?)<\/script>/giu)].map((match) => match[1]).join("\n"),
    );
    const click = (element) => {
      if (!element || element.disabled)
        throw new Error("cold-mcp-workbench-control-unavailable");
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    };
    const hostIds = [...window.document.querySelectorAll("[data-sanctioned-cli]")].map(
      (control) => control.getAttribute("data-sanctioned-cli"),
    );
    for (const target of hostIds) {
      const control = window.document.querySelector(`[data-sanctioned-cli="${target}"]`);
      if ((control.getAttribute("aria-pressed") === "true") !== targets.includes(target))
        click(control);
    }
    const posture = window.document.getElementById("posture");
    posture.value = "enterprise";
    posture.dispatchEvent(new window.Event("change", { bubbles: true }));
    if (posture.value !== "enterprise") throw new Error("cold-mcp-workbench-posture-refused");
    const managedMcp = window.document.getElementById("managed-mcp-projection");
    if (!managedMcp) throw new Error("cold-mcp-workbench-managed-opt-in-missing");
    managedMcp.checked = true;
    managedMcp.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (const server of servers) {
      const search = window.document.querySelector(
        "#framework-rows input[aria-label='Search catalog']",
      );
      if (!search) throw new Error("cold-mcp-workbench-search-unavailable");
      search.value = server;
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      click(
        window.document.querySelector(
          `button[data-workbench-row-action][data-workbench-asset-id="aih/${server}"]`,
        ),
      );
    }
    let downloaded;
    window.URL.createObjectURL = (blob) => {
      downloaded = blob;
      return "blob:aih-mcp-policy";
    };
    window.URL.revokeObjectURL = () => undefined;
    window.HTMLAnchorElement.prototype.click = function click() {};
    click(window.document.getElementById("download"));
    if (!downloaded) {
      process.stderr.write(
        `Packed fixture Workbench: ${window.document.getElementById("announcement")?.textContent ?? "no diagnostic"}\n`,
      );
      throw new Error("cold-mcp-workbench-policy-download-refused");
    }
    const policy = JSON.parse(await downloaded.text());
    if (policy.schemaVersion !== 3 || policy.minimumPosture !== "enterprise")
      throw new Error("cold-mcp-workbench-policy-contract");
    if (policy.governance.catalog.reviewed.length !== servers.length)
      throw new Error("cold-mcp-workbench-unexpected-controls");
    for (const server of servers) {
      const activation = policy.governance.activations.find(
        (item) => item.candidate === server,
      );
      if (
        activation?.state !== "active" ||
        JSON.stringify([...activation.targets].sort()) !== JSON.stringify([...targets].sort())
      )
        throw new Error("cold-mcp-workbench-target-selection");
    }
    if (authorityFields === undefined) return policy;
    // Same exact form/pending/download route as the existing packed protected
    // authority helper, within this session so MCP selection stays in the bundle.
    for (const [id, value] of Object.entries(authorityFields)) {
      const element = window.document.getElementById(id);
      if (!element || !("value" in element))
        throw new Error("cold-mcp-workbench-authority-field-missing");
      element.value = value;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    window.__aihPolicyWorkbenchPending = undefined;
    window.document
      .getElementById("protected-form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const pending = window.__aihPolicyWorkbenchPending;
    if (!pending || typeof pending.then !== "function")
      throw new Error("cold-mcp-workbench-authority-submit-refused");
    await pending;
    downloaded = undefined;
    click(window.document.getElementById("download-protected-bundle"));
    await window.__aihPolicyWorkbenchPending;
    if (!downloaded) throw new Error("cold-mcp-workbench-authority-download-refused");
    return JSON.parse(await downloaded.text());
  } finally {
    await window.happyDOM.close();
  }
}
