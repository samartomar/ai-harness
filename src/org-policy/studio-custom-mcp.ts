/**
 * Fixed pending custom MCP authoring forms (organization npm package and
 * fenced remote endpoint), shared by the legacy page and the new shell's
 * additions screen. Constant markup: no model value is interpolated.
 */
export function customMcpFormsMarkup(): string {
  return `    <details id="custom-editor"><summary>Add organization MCP</summary>
      <form id="custom-form" style="margin-top:8px">
        <fieldset>
          <legend>Pinned custom source</legend>
          <p class="help">Register a pinned organization MCP package and the person accountable for its evidence. The email is an audit identity, not an approval or credential. The candidate stays blocked; next, scan this exact package and bind the completed evidence record to the same pin.</p>
          <section class="governance-info" aria-labelledby="custom-source-guide-title">
            <h3 id="custom-source-guide-title">Find the exact MCP source</h3>
            <p class="help">Directories, READMEs, and documentation pages are discovery only. Use them to locate the publisher's canonical npm package or GitHub repository; never enter a listing or README URL as an MCP endpoint or treat an advertised install command as evidence.</p>
            <div class="brow">
              <a class="btn sm" data-mcp-source-search href="https://mcpmarket.com/" target="_blank" rel="noopener noreferrer">Search MCP directories</a>
              <a class="btn sm" data-mcp-source-search href="https://www.npmjs.com/search?q=mcp" target="_blank" rel="noopener noreferrer">Search npm</a>
              <a class="btn sm" data-mcp-source-search href="https://github.com/search?q=mcp+server&amp;type=repositories" target="_blank" rel="noopener noreferrer">Search GitHub</a>
            </div>
            <p class="help">Found an npm package? Copy its exact <code>name</code> from the publisher's install or <code>npx</code> command, npm page, or repository <code>package.json</code>. A directory title, publisher scope, SDK package, or SDK version may not identify the runnable MCP server. Found a GitHub repository or README? Use the exact-source route. Found a real hosted MCP endpoint? Use the separate pending remote MCP form.</p>
            <div class="brow"><button type="button" class="btn sm" id="open-protected-mcp">Use exact GitHub / README source</button></div>
            <p class="help mono" id="custom-scan-guide">Enter a canonical npm package and exact version to see the metadata and scan commands.</p>
          </section>
          <div class="form-grid">
            <label>Identifier <input id="custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label>
            <label>Accountable owner email <input id="custom-owner" type="email" autocomplete="email" placeholder="name@company.example" required></label>
            <label>Exact npm package name <input id="custom-package" placeholder="mcp-package or @scope/package" aria-describedby="custom-package-help" required></label>
            <label>Exact version <input id="custom-version" placeholder="1.2.3" required></label>
            <label>Integrity digest <input id="custom-integrity" placeholder="sha256:..." required></label>
            <label>Evidence record <input id="custom-evidence" required></label>
            <label>Clarification <input id="custom-note"></label>
          </div>
          <p class="help" id="custom-package-help">Use an unscoped package name or the complete <code>@scope/package</code>. A scope such as <code>@publisher</code> is not a package.</p>
          <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Add pending custom MCP</button></div>
        </fieldset>
      </form>
    </details>
    <details id="remote-custom-editor"><summary>Record a pending remote custom MCP</summary>
      <form id="remote-custom-form" style="margin-top:8px">
        <fieldset>
          <legend>Fenced remote endpoint</legend>
          <p class="help">AIH records the exact HTTPS origin and administrator-managed availability. Enter the approving person's email so the policy identifies the human decision-maker; it is an audit identity, not a credential. AIH does not contact or content-scan the endpoint, which remains non-projectable.</p>
          <div class="form-grid">
            <label>Identifier <input id="remote-custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label>
            <label>HTTPS origin <input id="remote-custom-origin" placeholder="https://mcp.example.com" required></label>
            <label>Approver email <input id="remote-custom-approved-by" type="email" autocomplete="email" placeholder="name@company.example" required></label>
            <label>Authentication mode <input id="remote-custom-authentication-mode" placeholder="oauth" required></label>
            <label>Allowed data classes <input id="remote-custom-data-classes" placeholder="design-metadata, issue-metadata" required></label>
            <label>Administrative status <select id="remote-custom-administrative-status"><option value="approved">approved</option><option value="revoked">revoked</option></select></label>
            <label>Evidence record <input id="remote-custom-evidence" required></label>
            <label>Clarification <input id="remote-custom-note"></label>
          </div>
          <p class="help">Content scan: none. This recorded identity is fenced until later remote-endpoint machinery.</p>
          <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Record pending remote MCP</button></div>
        </fieldset>
      </form>
    </details>`;
}
