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
              <div class="form-grid">
                <label>Bundle version <input id="protected-bundle-version" placeholder="acme-policy-1" required></label>
                <label>Issuer repository identity (attribution only) <input id="protected-issuer-repository" placeholder="organization/policy" required></label>
                <label>Authority issuer <input id="protected-issuer" placeholder="security-admin" required></label>
                <label>Authority issued at <input id="protected-issued-at" placeholder="2026-08-26T12:00:00Z" required></label>
                <label>Authority expires at <input id="protected-expires-at" placeholder="2026-09-25T12:00:00Z" required></label>
                <label>Decision identifier <input id="protected-decision-id" placeholder="decision-acme-tool-1" required></label>
                <label>Artifact kind <select id="protected-kind"><option value="tool">Tool</option><option value="skill">Skill</option><option value="mcp">MCP server</option><option value="package">Package</option><option value="profile">Profile</option></select></label>
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
                <label data-protected-source="aih" hidden>Exact AIH release <input id="protected-source-release" placeholder="0.2.0"></label>
                <label data-protected-source="aih" hidden>Exact AIH revision <input id="protected-source-revision" placeholder="sha256:..."></label>
                <label>Targets <input id="protected-targets" placeholder="claude,codex" required></label>
                <label>Allowed effects <input id="protected-effects" placeholder="observe,use" required></label>
                <label>Evidence identifier <input id="protected-evidence-id" placeholder="scan-001" required></label>
                <label>Evidence digest <input id="protected-evidence-digest" placeholder="sha256:..." required></label>
                <label>Evidence attestor <input id="protected-attestor" placeholder="organization-scanner" required></label>
                <label>Policy identifier <input id="protected-policy-id" placeholder="enterprise-policy" required></label>
                <label>Policy version <input id="protected-policy-version" placeholder="1" required></label>
                <label>Policy digest <input id="protected-policy-digest" placeholder="sha256:..." required></label>
                <label>Control identifier <input id="protected-control-id" placeholder="artifact-admission" required></label>
                <label>Control digest <input id="protected-control-digest" placeholder="sha256:..." required></label>
                <label>Accountable actor <input id="protected-actor" placeholder="security-reviewer" required></label>
                <label>Approval reason <input id="protected-reason" placeholder="Approved after evidence review" required></label>
              </div>
              <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Add exact artifact approval</button><button type="button" class="btn sm" id="download-protected-bundle" disabled>Download protected policy file</button></div>
            </fieldset>
          </form>
          <div id="protected-decision-rows"></div>
          <label for="protected-bundle-preview" class="help">Generated protected policy file (read-only preview)</label>
          <textarea id="protected-bundle-preview" readonly aria-label="Generated protected policy file"></textarea>
          <p class="help">Store the downloaded file at an administrator-controlled read-only path and configure Core to consume that path. Core still verifies the exact bytes, validity window, decision, evidence binding, and file custody before effects.</p>
        </div>
      </section>`;
}

/**
 * Dependency-free browser authoring logic. It uses Web Crypto for the exact
 * domain-separated digests consumed by Core and fails closed when unavailable.
 */
export function protectedPolicyWorkbenchScript(): string {
  return String.raw`
  const protectedIds=["protected-bundle-version","protected-issuer-repository","protected-issuer","protected-issued-at","protected-expires-at","protected-decision-id","protected-kind","protected-subject-id","protected-source-type","protected-source-repository","protected-source-commit","protected-source-path","protected-source-registry","protected-source-package","protected-source-version","protected-source-integrity","protected-source-filename","protected-source-sha256","protected-source-oci-registry","protected-source-oci-repository","protected-source-index-digest","protected-source-platform-os","protected-source-platform-architecture","protected-source-platform-variant","protected-source-manifest-digest","protected-source-endpoint","protected-source-content-digest","protected-source-release","protected-source-revision","protected-targets","protected-effects","protected-evidence-id","protected-evidence-digest","protected-attestor","protected-policy-id","protected-policy-version","protected-policy-digest","protected-control-id","protected-control-digest","protected-actor","protected-reason"];
  const protectedState={decisions:[],revocations:[],bundle:null,authority:null};
  const protectedId=/^[a-z][a-z0-9-]{0,63}$/;
  const protectedDigest=/^sha256:[0-9a-f]{64}$/;
  const protectedRepository=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const protectedTimestamp=function(value){return typeof value==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))};
  const protectedCanonicalTimestamp=function(value){return new Date(Date.parse(value)).toISOString()};
  const protectedSemver=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const protectedHttpsBase=function(value){try{const url=new URL(value);return url.protocol==="https:"&&url.username===""&&url.password===""&&url.search===""&&url.hash===""&&value===url.href&&url.pathname.endsWith("/")}catch{return false}};
  const protectedHttpsEndpoint=function(value){try{const url=new URL(value);return url.protocol==="https:"&&url.username===""&&url.password===""&&url.search===""&&url.hash===""&&value===url.href&&url.pathname.startsWith("/")}catch{return false}};
  const protectedSha512Sri=function(value){const match=/^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match){return false}try{const decoded=window.atob(match[1]);return decoded.length===64&&window.btoa(decoded)===match[1]}catch{return false}};
  const protectedOciRegistry=function(value){try{const url=new URL("https://"+value);const dns=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;return url.username===""&&url.password===""&&url.pathname==="/"&&url.search===""&&url.hash===""&&value===url.host&&(url.hostname.startsWith("[")||dns.test(url.hostname))}catch{return false}};
  const protectedOciRepository=function(value){return typeof value==="string"&&value.length>0&&value.length<=500&&value.split("/").every(function(segment){return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment)})};
  const protectedList=function(value){return Array.from(new Set(value.split(",").map(function(item){return item.trim()}).filter(Boolean))).sort()};
  const protectedNormalizeFields=function(){protectedIds.forEach(function(id){const field=byId(id);if(field&&typeof field.value==="string"){field.value=field.value.normalize("NFC")}})};
  const protectedStrictStrings=function(value,label){if(typeof value==="string"){for(let index=0;index<value.length;index+=1){const current=value.charCodeAt(index);if(current>=0xd800&&current<=0xdbff){const next=value.charCodeAt(index+1);if(!(next>=0xdc00&&next<=0xdfff)){throw new Error(label+" contains malformed Unicode")}index+=1;continue}if(current>=0xdc00&&current<=0xdfff){throw new Error(label+" contains malformed Unicode")}}if(value.normalize("NFC")!==value){throw new Error(label+" must already be NFC")}return}if(Array.isArray(value)){value.forEach(function(child,index){protectedStrictStrings(child,label+"["+String(index)+"]")});return}if(value!==null&&typeof value==="object"){Object.keys(value).forEach(function(key){protectedStrictStrings(key,label+" key");protectedStrictStrings(value[key],label+"."+key)})}};
  const protectedPath=function(value){return typeof value==="string"&&value.length>0&&value.length<=500&&value===value.trim()&&!value.startsWith("/")&&!value.includes("\\")&&value.split("/").every(function(part){return part!==""&&part!=="."&&part!==".."})&&!/[\p{C}]/u.test(value)};
  const protectedStableJson=function(value){if(Array.isArray(value)){return "["+value.map(protectedStableJson).join(",")+"]"}if(value!==null&&typeof value==="object"){return "{"+Object.keys(value).sort().map(function(key){return JSON.stringify(key)+":"+protectedStableJson(value[key])}).join(",")+"}"}return JSON.stringify(value)};
  const protectedSha256=async function(value){if(!(window.crypto&&window.crypto.subtle&&window.TextEncoder)){throw new Error("This browser cannot compute protected policy digests with Web Crypto.")}const bytes=new TextEncoder().encode(value);const result=await window.crypto.subtle.digest("SHA-256",bytes);return "sha256:"+Array.from(new Uint8Array(result)).map(function(byte){return byte.toString(16).padStart(2,"0")}).join("")};
  const protectedSourceDigest=function(source){return protectedSha256("aih-governance-decision-source/v2"+String.fromCharCode(0)+protectedStableJson(source))};
  const protectedSubjectDigest=function(subject){return protectedSha256("aih-governance-decision-subject/v2"+String.fromCharCode(0)+protectedStableJson(subject))};
  const protectedDecisionDigest=function(decision){return protectedSha256("aih-governance-decision/v2"+String.fromCharCode(0)+protectedStableJson(decision))};
  const protectedValues=function(){protectedNormalizeFields();return {bundleVersion:byId("protected-bundle-version").value.trim(),issuerRepository:byId("protected-issuer-repository").value.trim(),issuer:byId("protected-issuer").value.trim(),issuedAt:byId("protected-issued-at").value.trim(),expiresAt:byId("protected-expires-at").value.trim(),decisionId:byId("protected-decision-id").value.trim(),kind:byId("protected-kind").value,subjectId:byId("protected-subject-id").value.trim(),sourceType:byId("protected-source-type").value,sourceRepository:byId("protected-source-repository").value.trim(),sourceCommit:byId("protected-source-commit").value.trim(),sourcePath:byId("protected-source-path").value.trim(),sourceRegistry:byId("protected-source-registry").value.trim(),sourcePackage:byId("protected-source-package").value.trim(),sourceVersion:byId("protected-source-version").value.trim(),sourceIntegrity:byId("protected-source-integrity").value.trim(),sourceFilename:byId("protected-source-filename").value.trim(),sourceSha256:byId("protected-source-sha256").value.trim(),sourceOciRegistry:byId("protected-source-oci-registry").value.trim(),sourceOciRepository:byId("protected-source-oci-repository").value.trim(),sourceIndexDigest:byId("protected-source-index-digest").value.trim(),sourcePlatformOs:byId("protected-source-platform-os").value.trim(),sourcePlatformArchitecture:byId("protected-source-platform-architecture").value.trim(),sourcePlatformVariant:byId("protected-source-platform-variant").value.trim(),sourceManifestDigest:byId("protected-source-manifest-digest").value.trim(),sourceEndpoint:byId("protected-source-endpoint").value.trim(),sourceContentDigest:byId("protected-source-content-digest").value.trim(),sourceRelease:byId("protected-source-release").value.trim(),sourceRevision:byId("protected-source-revision").value.trim(),targets:protectedList(byId("protected-targets").value),effects:protectedList(byId("protected-effects").value),evidenceId:byId("protected-evidence-id").value.trim(),evidenceDigest:byId("protected-evidence-digest").value.trim(),attestor:byId("protected-attestor").value.trim(),policyId:byId("protected-policy-id").value.trim(),policyVersion:byId("protected-policy-version").value.trim(),policyDigest:byId("protected-policy-digest").value.trim(),controlId:byId("protected-control-id").value.trim(),controlDigest:byId("protected-control-digest").value.trim(),actor:byId("protected-actor").value.trim(),reason:byId("protected-reason").value.trim()}};
  const protectedIssues=function(values){
    const issues={};
    if(state.policy.minimumPosture!=="enterprise"){issues["protected-bundle-version"]="Choose Enterprise posture before creating authority."}
    if(!visible(values.bundleVersion)){issues["protected-bundle-version"]="Use a visible bundle version."}
    if(!protectedRepository.test(values.issuerRepository)){issues["protected-issuer-repository"]="Use organization/repository."}
    if(!protectedId.test(values.issuer)){issues["protected-issuer"]="Use a lowercase stable issuer identifier."}
    if(protectedState.authority&&(protectedState.authority.issuer!==values.issuer||protectedState.authority.issuerRepository!==values.issuerRepository)){issues["protected-issuer-repository"]="Existing decisions are bound to the original issuer identity; start a new file to change it."}
    if(!protectedTimestamp(values.issuedAt)){issues["protected-issued-at"]="Use an offset-qualified ISO-8601 time."}
    if(!protectedTimestamp(values.expiresAt)){issues["protected-expires-at"]="Use an offset-qualified ISO-8601 time."}
    if(protectedTimestamp(values.issuedAt)&&protectedTimestamp(values.expiresAt)){const issued=Date.parse(values.issuedAt),expires=Date.parse(values.expiresAt);if(expires<=issued||expires-issued>7776000000){issues["protected-expires-at"]="Authority must expire after issue and within 90 days."}if(protectedState.decisions.some(function(decision){return Date.parse(decision.issuedAt)>issued})){issues["protected-issued-at"]="Authority issuance cannot precede an included decision."}if(protectedState.decisions.some(function(decision){return Date.parse(decision.expiresAt)>expires})){issues["protected-expires-at"]="Authority expiry cannot precede an included decision expiry."}}
    if(!/^decision-[a-z0-9-]{1,55}$/.test(values.decisionId)){issues["protected-decision-id"]="Use a decision- prefixed stable identifier."}
    if(!/^(tool|skill|mcp|package|profile)$/.test(values.kind)){issues["protected-kind"]="Choose an artifact kind."}
    if(!protectedId.test(values.subjectId)){issues["protected-subject-id"]="Use a lowercase stable artifact identifier."}
    if(!/^(github|npm|pypi|oci|remote|aih)$/.test(values.sourceType)){issues["protected-source-type"]="Choose an exact source type."}
    if(values.sourceType==="github"){
      if(!protectedRepository.test(values.sourceRepository)){issues["protected-source-repository"]="Use organization/repository."}
      if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(values.sourceCommit)){issues["protected-source-commit"]="Use an exact lowercase 40 or 64 character commit."}
      if(!protectedPath(values.sourcePath)){issues["protected-source-path"]="Use a safe relative source path."}
    }else if(values.sourceType==="npm"){
      if(!protectedHttpsBase(values.sourceRegistry)){issues["protected-source-registry"]="Use a canonical HTTPS registry URL ending in /."}
      if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(values.sourcePackage)){issues["protected-source-package"]="Use an exact npm package name."}
      if(!protectedSemver.test(values.sourceVersion)){issues["protected-source-version"]="Use an exact semantic version."}
      if(!protectedSha512Sri(values.sourceIntegrity)){issues["protected-source-integrity"]="Use a canonical sha512 SRI digest."}
    }else if(values.sourceType==="pypi"){
      if(!protectedHttpsBase(values.sourceRegistry)){issues["protected-source-registry"]="Use a canonical HTTPS registry URL ending in /."}
      if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.sourcePackage)){issues["protected-source-package"]="Use a canonical PyPI package name."}
      if(!/^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,127}$/.test(values.sourceVersion)){issues["protected-source-version"]="Use an exact PyPI version."}
      if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(values.sourceFilename)){issues["protected-source-filename"]="Use the exact distribution filename."}
      if(!protectedDigest.test(values.sourceSha256)){issues["protected-source-sha256"]="Use the exact sha256 distribution digest."}
    }else if(values.sourceType==="oci"){
      if(!protectedOciRegistry(values.sourceOciRegistry)){issues["protected-source-oci-registry"]="Use a canonical OCI registry authority."}
      if(!protectedOciRepository(values.sourceOciRepository)){issues["protected-source-oci-repository"]="Use canonical lowercase OCI repository segments."}
      if(!protectedDigest.test(values.sourceIndexDigest)){issues["protected-source-index-digest"]="Use the exact sha256 index digest."}
      if(!protectedId.test(values.sourcePlatformOs)){issues["protected-source-platform-os"]="Use a stable operating-system identifier."}
      if(!protectedId.test(values.sourcePlatformArchitecture)){issues["protected-source-platform-architecture"]="Use a stable architecture identifier."}
      if(values.sourcePlatformVariant!==""&&!protectedId.test(values.sourcePlatformVariant)){issues["protected-source-platform-variant"]="Use a stable variant identifier or leave it empty."}
      if(!protectedDigest.test(values.sourceManifestDigest)){issues["protected-source-manifest-digest"]="Use the exact sha256 manifest digest."}
    }else if(values.sourceType==="remote"){
      if(!protectedHttpsEndpoint(values.sourceEndpoint)){issues["protected-source-endpoint"]="Use a canonical HTTPS endpoint without credentials, query, or fragment."}
      if(!protectedDigest.test(values.sourceContentDigest)){issues["protected-source-content-digest"]="Use the exact sha256 content digest."}
    }else if(values.sourceType==="aih"){
      if(!protectedSemver.test(values.sourceRelease)){issues["protected-source-release"]="Use an exact AIH semantic version."}
      if(!protectedDigest.test(values.sourceRevision)){issues["protected-source-revision"]="Use the exact AIH sha256 revision."}
    }
    if(values.targets.length<1||values.targets.length>64||values.targets.some(function(item){return !protectedId.test(item)})){issues["protected-targets"]="Use one to 64 comma-separated target identifiers."}
    if(values.effects.length<1||values.effects.some(function(item){return !/^(configure|install|observe|use)$/.test(item)})){issues["protected-effects"]="Use configure, install, observe, and/or use."}
    [["protected-evidence-id",values.evidenceId],["protected-attestor",values.attestor],["protected-policy-id",values.policyId],["protected-control-id",values.controlId],["protected-actor",values.actor]].forEach(function(entry){if(!protectedId.test(entry[1])){issues[entry[0]]="Use a lowercase stable identifier."}});
    [["protected-evidence-digest",values.evidenceDigest],["protected-policy-digest",values.policyDigest],["protected-control-digest",values.controlDigest]].forEach(function(entry){if(!protectedDigest.test(entry[1])){issues[entry[0]]="Use sha256: followed by 64 lowercase hex characters."}});
    if(!visible(values.policyVersion)){issues["protected-policy-version"]="Use a visible policy version."}
    if(!visible(values.reason)){issues["protected-reason"]="Use a visible accountable approval reason."}
    if(protectedState.decisions.length>=64){issues["protected-decision-id"]="A protected file can contain at most 64 decisions."}
    if(protectedState.decisions.some(function(decision){return decision.id===values.decisionId})){issues["protected-decision-id"]="That decision identifier is already in this file."}
    return issues
  };
  const protectedRecover=function(issues){protectedIds.forEach(function(id){fieldError(id,issues[id]||"")});let first;Object.keys(issues).forEach(function(id){first=first||byId(id)});announce("Correct the highlighted protected policy fields.",true);if(first){first.focus()}};
  const protectedBuildSource=function(values){
    if(values.sourceType==="github"){return {type:"github",repository:values.sourceRepository,commit:values.sourceCommit,path:values.sourcePath}}
    if(values.sourceType==="npm"){return {type:"npm",registry:values.sourceRegistry,package:values.sourcePackage,version:values.sourceVersion,integrity:values.sourceIntegrity}}
    if(values.sourceType==="pypi"){return {type:"pypi",registry:values.sourceRegistry,package:values.sourcePackage,version:values.sourceVersion,filename:values.sourceFilename,sha256:values.sourceSha256}}
    if(values.sourceType==="oci"){const platform={os:values.sourcePlatformOs,architecture:values.sourcePlatformArchitecture};if(values.sourcePlatformVariant){platform.variant=values.sourcePlatformVariant}return {type:"oci",registry:values.sourceOciRegistry,repository:values.sourceOciRepository,indexDigest:values.sourceIndexDigest,platform:platform,manifestDigest:values.sourceManifestDigest}}
    if(values.sourceType==="remote"){return {type:"remote",endpoint:values.sourceEndpoint,contentDigest:values.sourceContentDigest}}
    return {type:"aih",release:values.sourceRelease,revision:values.sourceRevision}
  };
  const protectedBuildDecision=async function(values){const source=protectedBuildSource(values);const sourceDigest=await protectedSourceDigest(source);const subjectDescriptor={kind:values.kind,id:values.subjectId,sourceDigest:sourceDigest};const subjectDigest=await protectedSubjectDigest(subjectDescriptor);const issuedAt=protectedCanonicalTimestamp(values.issuedAt);const expiresAt=protectedCanonicalTimestamp(values.expiresAt);return {format:"aih-governance-decision",version:2,id:values.decisionId,qualificationBasis:{kind:"organization-qualified",evidenceDigest:values.evidenceDigest,attestor:values.attestor},subject:{kind:values.kind,id:values.subjectId,source:source,sourceDigest:sourceDigest,subjectDigest:subjectDigest},targets:values.targets,allowedEffects:values.effects,policy:{id:values.policyId,version:values.policyVersion,digest:values.policyDigest},control:{id:values.controlId,digest:values.controlDigest},evidence:{id:values.evidenceId,digest:values.evidenceDigest,attestor:values.attestor},issuer:values.issuer,actor:values.actor,reason:values.reason,issuedAt:issuedAt,notBefore:issuedAt,expiresAt:expiresAt,disposition:"approved",acceptedFindings:[],acceptedGaps:[],conditions:[]}};
  const protectedSourceLabel=function(source){if(source.type==="github"){return source.repository+"@"+source.commit}if(source.type==="npm"||source.type==="pypi"){return source.package+"@"+source.version}if(source.type==="oci"){return source.registry+"/"+source.repository+"@"+source.manifestDigest}if(source.type==="remote"){return source.endpoint+"@"+source.contentDigest}return "AIH "+source.release+"@"+source.revision};
  const protectedRenderRows=function(){const host=byId("protected-decision-rows");host.innerHTML="";protectedState.decisions.forEach(function(decision,index){const row=document.createElement("div");row.className="row";const detail=document.createElement("div");detail.className="row-slot";const title=document.createElement("b");title.textContent=decision.id;const summary=document.createElement("p");summary.className="mono";summary.textContent=decision.subject.kind+" "+decision.subject.id+" at "+protectedSourceLabel(decision.subject.source);detail.append(title,summary);const remove=document.createElement("button");remove.type="button";remove.textContent="Remove";remove.dataset.protectedRemove=String(index);const revoke=document.createElement("button");revoke.type="button";revoke.textContent="Revoke";revoke.dataset.protectedRevoke=String(index);row.append(detail,remove,revoke);host.append(row)})};
  const protectedBuildBundle=function(values){const decisions=protectedState.decisions.slice().sort(function(left,right){return left.id<right.id?-1:left.id>right.id?1:0});const targets=Array.from(new Set(decisions.flatMap(function(decision){return decision.targets}))).sort();const issuedAt=protectedCanonicalTimestamp(values.issuedAt);return {schemaVersion:2,bundleVersion:values.bundleVersion,issuer:values.issuer,issuedAt:issuedAt,policy:structuredClone(state.policy),authorityReceipt:{format:"aih-policy-authority-receipt",version:3,issuerRepository:values.issuerRepository,issuedAt:issuedAt,expiresAt:protectedCanonicalTimestamp(values.expiresAt),trustedIssuers:[{id:values.issuer,githubRepository:values.issuerRepository}],targets:targets,decisions:decisions,decisionRevocations:protectedState.revocations.slice().sort(function(left,right){return left.decisionDigest<right.decisionDigest?-1:left.decisionDigest>right.decisionDigest?1:0})}}};
  const protectedRefresh=function(values){const bundle=protectedBuildBundle(values);protectedStrictStrings(bundle,"bundle");const problems=schemaErrors(model.protectedBundleSchema,bundle,"bundle");if(problems.length){throw new Error("Generated file failed the embedded Core schema: "+problems.slice(0,3).join("; "))}protectedState.bundle=bundle;byId("protected-bundle-preview").value=JSON.stringify(bundle,null,2)+"\n";byId("download-protected-bundle").disabled=false;protectedRenderRows();return bundle};
  const protectedRun=function(task){const pending=(async function(){try{await task()}catch(error){announce("Protected policy generation refused: "+(error&&error.message?error.message:"valid form fields are required"),true)}})();window.__aihPolicyWorkbenchPending=pending;return pending};
  byId("protected-form").addEventListener("submit",function(event){event.preventDefault();event.stopImmediatePropagation();const values=protectedValues();const issues=protectedIssues(values);if(Object.keys(issues).length){protectedRecover(issues);return}protectedRun(async function(){const decision=await protectedBuildDecision(values);protectedState.decisions.push(decision);protectedState.authority=protectedState.authority||{issuer:values.issuer,issuerRepository:values.issuerRepository};try{protectedRefresh(values)}catch(error){protectedState.decisions.pop();if(!protectedState.decisions.length){protectedState.authority=null}throw error}protectedIds.forEach(function(id){fieldError(id,"")});announce("The protected policy file is ready. Core must still verify its exact bytes and current authority before effects.")})});
  byId("protected-decision-rows").addEventListener("click",function(event){const remove=event.target.closest&&event.target.closest("[data-protected-remove]");const revoke=event.target.closest&&event.target.closest("[data-protected-revoke]");if(remove){const index=Number(remove.dataset.protectedRemove);const decision=protectedState.decisions[index];if(!Number.isInteger(index)||!decision){return}protectedRun(async function(){const digest=await protectedDecisionDigest(decision);protectedState.decisions.splice(index,1);protectedState.revocations=protectedState.revocations.filter(function(item){return item.decisionDigest!==digest});const values=protectedValues();if(protectedState.decisions.length){protectedRefresh(values)}else{protectedState.bundle=null;protectedState.authority=null;byId("protected-bundle-preview").value="";byId("download-protected-bundle").disabled=true;protectedRenderRows()}announce("Exact artifact approval removed from the generated file.")});return}if(revoke){const index=Number(revoke.dataset.protectedRevoke);const decision=protectedState.decisions[index];if(!decision){return}protectedRun(async function(){const values=protectedValues();const issues=protectedIssues(Object.assign({},values,{decisionId:"decision-placeholder"}));delete issues["protected-decision-id"];if(Object.keys(issues).length){protectedRecover(issues);return}const digest=await protectedDecisionDigest(decision);if(!protectedState.revocations.some(function(item){return item.decisionDigest===digest})){protectedState.revocations.push({format:"aih-governance-decision-revocation",version:2,decisionDigest:digest,issuer:decision.issuer,revokedAt:protectedCanonicalTimestamp(values.issuedAt),reason:"Revoked by the accountable administrator in Policy Workbench"})}protectedRefresh(values);announce("The decision revocation is included in the protected policy file.")})}});
  byId("download-protected-bundle").addEventListener("click",function(){protectedRun(async function(){const values=protectedValues();const issues=protectedIssues(Object.assign({},values,{decisionId:"decision-placeholder"}));delete issues["protected-decision-id"];if(Object.keys(issues).length||protectedState.decisions.length===0){if(Object.keys(issues).length){protectedRecover(issues)}else{announce("Add at least one exact artifact approval before download.",true)}return}const bundle=protectedRefresh(values);const blob=new Blob([JSON.stringify(bundle,null,2)+"\n"],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-policy-bundle.json";link.click();URL.revokeObjectURL(url);announce("Protected policy file download started. Place it at an administrator-controlled read-only path.")})});
  const protectedSourceVisibility=function(){const selected=byId("protected-source-type").value;document.querySelectorAll("[data-protected-source]").forEach(function(label){const active=label.dataset.protectedSource.split(" ").includes(selected);label.hidden=!active;const input=label.querySelector("input,select");if(input){input.disabled=!active}})};
  byId("protected-source-type").addEventListener("change",protectedSourceVisibility);
  protectedIds.forEach(function(id){byId(id).addEventListener("input",function(){fieldError(id,"")})});
  protectedSourceVisibility();
`;
}
