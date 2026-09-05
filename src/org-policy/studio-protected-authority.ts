/** Fixed Enterprise protected-file authoring surface embedded in the portable Workbench. */
export function protectedPolicyWorkbenchMarkup(): string {
  return `
      <section class="gcard grp group" data-open="1" data-owner="You" data-groupcard>
        <button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>Protected Enterprise policy file</h2><span class="own">You</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button>
        <div class="grpbody stack">
          <form id="protected-form" class="dform">
            <fieldset>
              <legend>Organization authority and exact artifact approval</legend>
              <p class="help">Fill ordinary fields. The Workbench computes canonical Decision V2 digests and emits one PolicyBundle V2 file for a read-only administrator-controlled location. No GitHub workflow or hand-authored JSON is required.</p>
              <p class="note" id="organization-artifact-context">Organization-owned exact artifacts use this Catalog-independent route after attributable scan evidence exists. Core records exact observed state; it does not install or run the artifact.</p>
              <section class="governance-info" aria-labelledby="protected-source-guide-title">
                <h3 id="protected-source-guide-title">Find and scan the exact source</h3>
                <p class="help">Search directories to discover a candidate, then copy the publisher's canonical repository, exact commit, item name, and source path. A directory page, README, popularity count, advertised install command, or third-party audit is not AIH evidence or organization approval.</p>
                <div class="brow">
                  <a class="btn sm" data-protected-source-search href="https://www.skills.sh/" target="_blank" rel="noopener noreferrer">Search Skills</a>
                  <a class="btn sm" data-protected-source-search href="https://github.com/search?q=agent+skill&amp;type=repositories" target="_blank" rel="noopener noreferrer">Search GitHub</a>
                  <a class="btn sm" data-protected-source-search href="https://www.npmjs.com/search?q=agent+skill" target="_blank" rel="noopener noreferrer">Search npm</a>
                </div>
                <p class="help mono" id="protected-scan-guide">Copy the repository, exact commit, item name, and source path, then this panel will show the exact read-only vet or scan command.</p>
              </section>
              <div class="form-grid">
                <label>Bundle version <input id="protected-bundle-version" placeholder="acme-policy-1" required></label>
                <label>Issuer repository identity (attribution only) <input id="protected-issuer-repository" placeholder="organization/policy" required></label>
                <label>Authority issuer <input id="protected-issuer" placeholder="security-admin" required></label>
                <label>Authority issued at <input id="protected-issued-at" placeholder="2026-08-26T12:00:00Z" required></label>
                <label>Authority expires at <input id="protected-expires-at" placeholder="2026-09-25T12:00:00Z" required></label>
                <label>Decision identifier <input id="protected-decision-id" placeholder="decision-acme-tool-1" required></label>
                <label>Artifact kind <select id="protected-kind"><option value="tool">Tool</option><option value="skill">Skill</option><option value="agent">Agent</option><option value="mcp">MCP server</option><option value="package">Package</option><option value="profile">Profile</option></select></label>
                <label>Artifact identifier <input id="protected-subject-id" placeholder="acme-tool" required></label>
                <label>Source type <select id="protected-source-type"><option value="github">Exact GitHub source</option><option value="npm">Exact npm package</option><option value="pypi">Exact PyPI package</option><option value="oci">Exact OCI image</option><option value="remote">Exact remote content</option><option value="aih">Exact AIH release</option></select></label>
                <label data-protected-source="github">Exact GitHub repository <input id="protected-source-repository" placeholder="organization/repository"></label>
                <label data-protected-source="github">Exact commit <input id="protected-source-commit" placeholder="40 or 64 lowercase hex characters"></label>
                <label data-protected-source="github">Source path <input id="protected-source-path" placeholder="relative/path"></label>
                <label data-protected-source="npm pypi" hidden>Canonical HTTPS registry <input id="protected-source-registry" placeholder="https://registry.example.test/"></label>
                <label data-protected-source="npm pypi" hidden>Exact package <input id="protected-source-package" placeholder="@organization/package"></label>
                <label data-protected-source="npm pypi" hidden>Exact version <input id="protected-source-version" placeholder="1.2.3"></label>
                <label data-protected-source="npm" hidden>Exact sha512 SRI integrity <input id="protected-source-integrity" placeholder="sha512-..."></label>
                <label data-protected-source="pypi" hidden>Exact distribution filename <input id="protected-source-filename" placeholder="package-1.2.3.whl"></label>
                <label data-protected-source="pypi" hidden>Exact distribution digest <input id="protected-source-sha256" placeholder="sha256:..."></label>
                <label data-protected-source="oci" hidden>Canonical OCI registry <input id="protected-source-oci-registry" placeholder="ghcr.io"></label>
                <label data-protected-source="oci" hidden>OCI repository <input id="protected-source-oci-repository" placeholder="organization/image"></label>
                <label data-protected-source="oci" hidden>Exact OCI index digest <input id="protected-source-index-digest" placeholder="sha256:..."></label>
                <label data-protected-source="oci" hidden>Platform operating system <input id="protected-source-platform-os" placeholder="linux"></label>
                <label data-protected-source="oci" hidden>Platform architecture <input id="protected-source-platform-architecture" placeholder="amd64"></label>
                <label data-protected-source="oci" hidden>Platform variant (optional) <input id="protected-source-platform-variant" placeholder="v8"></label>
                <label data-protected-source="oci" hidden>Exact OCI manifest digest <input id="protected-source-manifest-digest" placeholder="sha256:..."></label>
                <label data-protected-source="remote" hidden>Canonical HTTPS endpoint <input id="protected-source-endpoint" placeholder="https://mcp.example.test/v1/server"></label>
                <label data-protected-source="remote" hidden>Exact content digest <input id="protected-source-content-digest" placeholder="sha256:..."></label>
                <label data-protected-source="aih" hidden>Exact AIH release <input id="protected-source-release" placeholder="0.3.0"></label>
                <label data-protected-source="aih" hidden>Exact AIH revision <input id="protected-source-revision" placeholder="sha256:..."></label>
                <label>Targets <input id="protected-targets" placeholder="claude,codex" required></label>
                <label>Allowed effects <input id="protected-effects" placeholder="observe,use" required></label>
                <label>Qualification basis <select id="protected-qualification-kind" aria-describedby="protected-qualification-guide"><option value="organization-qualified">Organization-qualified evidence</option><option value="aih-supported">AIH-supported Catalog receipt</option></select></label>
                <label data-protected-qualification="aih-supported" hidden>Catalog signer identity <input id="protected-catalog-signer" placeholder="administrator:aih-supported/catalog-v2"></label>
                <label data-protected-qualification="aih-supported" hidden>Exact Catalog digest <input id="protected-catalog-digest" placeholder="sha256:..."></label>
                <label data-protected-qualification="aih-supported" hidden>Exact Catalog head digest <input id="protected-catalog-head-digest" placeholder="sha256:..."></label>
                <label data-protected-qualification="aih-supported" hidden>Exact Catalog member digest <input id="protected-catalog-member-digest" placeholder="sha256:..."></label>
                <label>Evidence identifier <input id="protected-evidence-id" placeholder="scan-001" required></label>
                <label>Evidence digest <input id="protected-evidence-digest" placeholder="sha256:..." required></label>
                <label>Evidence attestor <input id="protected-attestor" placeholder="organization-scanner" required></label>
                <label>Policy identifier <input id="protected-policy-id" placeholder="enterprise-policy" required></label>
                <label>Policy version <input id="protected-policy-version" placeholder="1" required></label>
                <label>Policy digest <input id="protected-policy-digest" placeholder="sha256:..." required></label>
                <label>Control identifier <input id="protected-control-id" placeholder="artifact-admission" required></label>
                <label>Control digest <input id="protected-control-digest" placeholder="sha256:..." required></label>
                <label>Accountable owner email <input id="protected-actor" type="email" autocomplete="email" placeholder="name@company.example" required></label>
                <label>Approval reason <input id="protected-reason" placeholder="Approved after evidence review" required></label>
              </div>
              <p class="help" id="protected-qualification-guide">Organization-qualified evidence binds this decision directly to the exact evidence digest and attestor.</p>
              <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Add exact artifact approval</button><button type="button" class="btn sm" id="download-protected-bundle" disabled>Download protected policy file</button><button type="button" class="btn sm" id="download-protected-evidence" disabled>Download organization evidence envelope</button></div>
            </fieldset>
          </form>
          <div id="protected-decision-rows"></div>
          <label for="protected-bundle-preview" class="help">Generated protected policy file (read-only preview)</label>
          <textarea id="protected-bundle-preview" readonly aria-label="Generated protected policy file"></textarea>
          <label for="protected-evidence-preview" class="help">Generated canonical organization evidence envelope (read-only preview)</label>
          <textarea id="protected-evidence-preview" readonly aria-label="Generated canonical organization evidence envelope"></textarea>
          <p class="help">Store the downloaded file at an administrator-controlled read-only path and configure Core to consume that path. Core still verifies the exact bytes, validity window, decision, evidence binding, and file custody before effects.</p>
        </div>
      </section>`;
}

/**
 * Dependency-free browser authoring logic. It uses Web Crypto for the exact
 * domain-separated digests consumed by Core and fails closed when unavailable.
 */
