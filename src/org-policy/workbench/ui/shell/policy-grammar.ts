/**
 * Headless policy grammar extracted from the legacy Workbench runtime (S0).
 *
 * Every function here is a verbatim port of a closure in `legacy-runtime.js`
 * (original minified name noted on each export). The legacy runtime now calls
 * these functions, so its behaviour is this module's behaviour; the
 * characterization tests in `tests/org-policy/workbench/` pin both. Do not
 * "fix" wording or ordering here: messages and their order are observable
 * (announcements, the first three errors, download gates).
 */
import { withLegacyPolicyCandidateDefaultsV1 as normalizeLegacyCandidateDefaults } from "../../policy-import.js";
import { policySchemaErrors } from "../../schema-validation.js";

/**
 * Imported policy JSON is walked exactly as the legacy runtime walked it:
 * untyped, with truthiness guards. Narrowing it would change which malformed
 * inputs throw versus report, so the grammar keeps the loose shape.
 */
// biome-ignore lint/suspicious/noExplicitAny: verbatim port of untyped legacy policy JSON walking
type Loose = any;

/** The subset of the embedded Workbench model the grammar reads. */
export interface PolicyGrammarModel {
  readonly schema: unknown;
  readonly catalog: { readonly hosts?: ReadonlyArray<{ readonly id: string }> };
  readonly workbenchBindings?: unknown;
  readonly workbenchBundle?: unknown;
}

export interface PolicyGrammarContext {
  readonly model: PolicyGrammarModel;
  /** Returns the live selection validator (legacy: `window.__aihWorkbenchValidatePolicy`). */
  readonly selectionValidator: () => unknown;
}

export interface PreparedPolicyImport {
  readonly policy: Loose;
  readonly message: string;
}

/** Legacy `A()`: the empty governance block a fresh policy starts from. */
export function emptyGovernance(): Record<string, unknown> {
  return {
    policyVersion: "1",
    catalog: { reviewed: [], custom: [] },
    activations: [],
    authority: { approvals: [] },
    externalCuration: [],
    externalSelections: [],
  };
}

/** Legacy `j()` body: the governance block, or the empty block merged under it. */
export function governanceOrDefault(governance: Loose): Loose {
  return governance?.policyVersion
    ? governance
    : Object.assign(emptyGovernance(), governance || {});
}

/** Legacy `R()`: the exact downloaded policy bytes. */
export function serializePolicy(policy: unknown): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** Legacy `P`: one grammar diagnostic. */
export function grammarMessage(path: string | undefined, text: string): string {
  return `${path || "policy"}: ${text}`;
}

/** Legacy `_e`. */
export function checkVisibleText(value: unknown, path: string, errors: string[]): void {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 500 ||
    !/\S/u.test(value) ||
    /\p{C}/u.test(value)
  )
    errors.push(
      grammarMessage(
        path,
        "must be visible single-line text without hidden Unicode or surrounding whitespace",
      ),
    );
}

/** Legacy `Ge`. */
export function checkRepoRelativePath(value: unknown, path: string, errors: string[]): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    errors.push(grammarMessage(path, "must be a safe repo-relative POSIX path"));
}

/** Legacy `Ae`. */
export function checkIsoTimestamp(value: unknown, path: string, errors: string[]): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    errors.push(grammarMessage(path, "must be an ISO-8601 timestamp"));
}

function isExactRegistryOriginArgument(argument: unknown): boolean {
  const match =
    typeof argument === "string" && /^--(?:registry|index-url)=(https:\/\/[^/?#]+)$/.exec(argument);
  const url = match ? new URL(match[1] as string) : null;
  return Boolean(
    url &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
  );
}

function isUnsafeCommandArgument(argument: unknown): boolean {
  return (
    typeof argument !== "string" ||
    argument.startsWith("/") ||
    argument.startsWith("\\") ||
    argument.includes("..") ||
    /[\\/;|&$<>\p{C}]/u.test(argument) ||
    argument.includes("`")
  );
}

/** Legacy `ue`: command-source arguments must be safe and relative. */
export function checkCommandArguments(source: Loose, path: string, errors: string[]): void {
  if (!source || typeof source !== "object") return;
  if (source.type !== "command") return;
  (source.args || []).forEach((argument: unknown, index: number) => {
    if (!isExactRegistryOriginArgument(argument) && isUnsafeCommandArgument(argument))
      errors.push(grammarMessage(`${path}.args[${index}]`, "must be a safe relative argument"));
  });
}

/** Legacy `be`: one catalog candidate in the reviewed or custom list. */
export function checkCandidate(
  candidate: Loose,
  path: string,
  list: "reviewed" | "custom",
  errors: string[],
): void {
  if (!candidate || typeof candidate !== "object") return;
  checkVisibleText(candidate.description, `${path}.description`, errors);
  (candidate.capabilities || []).forEach((value: unknown, index: number) => {
    checkVisibleText(value, `${path}.capabilities[${index}]`, errors);
  });
  (candidate.risks || []).forEach((value: unknown, index: number) => {
    checkVisibleText(value, `${path}.risks[${index}]`, errors);
  });
  if (candidate.clarification !== undefined)
    checkVisibleText(candidate.clarification, `${path}.clarification`, errors);
  if (candidate.annotation !== undefined)
    checkVisibleText(candidate.annotation, `${path}.annotation`, errors);
  const source = candidate.source || {};
  checkCommandArguments(source, `${path}.source`, errors);
  if (
    candidate.kind === "mcp" &&
    source.type !== "mcp" &&
    source.type !== "stdio" &&
    source.type !== "remote"
  )
    errors.push(
      grammarMessage(
        `${path}.source`,
        "MCP candidates require exact catalog, pinned stdio, or fenced remote identity",
      ),
    );
  if (candidate.kind === "mcp" && source.type === "mcp" && candidate.id !== source.server)
    errors.push(grammarMessage(`${path}.id`, "must match built-in MCP source.server"));
  if (candidate.kind === "hook" && source.type !== "hook")
    errors.push(
      grammarMessage(`${path}.source`, "hook candidates require an AIH-owned hook identity"),
    );
  if (candidate.kind === "hook" && source.type === "hook" && candidate.id !== source.handler)
    errors.push(grammarMessage(`${path}.id`, "must match AIH hook handler"));
  if (candidate.kind === "framework" && !candidate.framework)
    errors.push(grammarMessage(`${path}.framework`, "is required for framework candidates"));
  if (candidate.kind !== "framework" && candidate.framework !== undefined)
    errors.push(grammarMessage(`${path}.framework`, "is only valid for framework candidates"));
  if (
    candidate.kind === "framework" &&
    (candidate.projector !== "framework-contract" ||
      candidate.autoExecute ||
      !Array.isArray(candidate.targets) ||
      candidate.targets.length !== 1 ||
      candidate.targets[0] !== "claude")
  )
    errors.push(
      grammarMessage(
        path,
        "framework candidates must be Claude-only, non-autoexecuting framework-contract records",
      ),
    );
  if (list === "reviewed" && source.type !== "mcp" && source.type !== "hook")
    errors.push(
      grammarMessage(
        `${path}.source`,
        "reviewed candidates must reference AIH-shipped MCP or hook identities",
      ),
    );
  if (
    list === "custom" &&
    candidate.kind === "mcp" &&
    source.type !== "stdio" &&
    source.type !== "remote"
  )
    errors.push(
      grammarMessage(
        `${path}.source`,
        "custom MCP candidates must use pinned stdio or fenced remote identity",
      ),
    );
  if (list === "custom" && candidate.kind === "hook")
    errors.push(grammarMessage(path, "custom hooks are unsupported"));
}

/** Legacy `Pe`: remote MCP candidates cannot target Kiro. */
export function kiroRemoteMcpErrors(policy: Loose): string[] {
  const errors: string[] = [];
  const governance = policy?.governance;
  if (!governance || typeof governance !== "object") return errors;
  const catalog = governance.catalog || {};
  for (const list of ["reviewed", "custom"]) {
    (catalog[list] || []).forEach((candidate: Loose, index: number) => {
      if (
        candidate &&
        candidate.kind === "mcp" &&
        candidate.source &&
        candidate.source.type === "remote" &&
        Array.isArray(candidate.targets) &&
        candidate.targets.includes("kiro")
      )
        errors.push(
          grammarMessage(
            `policy.governance.catalog.${list}[${index}].targets`,
            "Kiro MCP projection supports stdio catalog entries only",
          ),
        );
    });
  }
  return errors;
}

/** Legacy `nt`: the governance grammar (CLIs, candidates, activations, authority, curation). */
export function governanceGrammarErrors(policy: Loose, model: PolicyGrammarModel): string[] {
  const errors: string[] = [];
  const governance = policy?.governance;
  const hostIds = (model.catalog.hosts || []).map((host) => host.id);
  if (
    policy &&
    policy.minimumPosture === "enterprise" &&
    (!governance ||
      typeof governance !== "object" ||
      !Array.isArray(governance.supportedClis) ||
      governance.supportedClis.length === 0)
  )
    errors.push(
      grammarMessage(
        "policy.governance.supportedClis",
        `enterprise posture requires a non-empty explicit allow-list; current registry ids: ${hostIds.join(", ")}. Paste every id to sanction all supported CLIs; wildcard sentinels are not supported`,
      ),
    );
  if (!governance || typeof governance !== "object") return errors;
  const hasSupportedClis = Array.isArray(governance.supportedClis);
  const supportedClis: Loose[] = hasSupportedClis ? governance.supportedClis : [];
  if (new Set(supportedClis).size !== supportedClis.length)
    errors.push(
      grammarMessage("policy.governance.supportedClis", "supported CLI entries must be unique"),
    );
  const catalog = governance.catalog || {};
  const reviewed: Loose[] = Array.isArray(catalog.reviewed) ? catalog.reviewed : [];
  const custom: Loose[] = Array.isArray(catalog.custom) ? catalog.custom : [];
  reviewed.forEach((candidate, index) => {
    const path = `policy.governance.catalog.reviewed[${index}]`;
    checkCandidate(candidate, path, "reviewed", errors);
    if (
      candidate.source &&
      candidate.source.type === "hook" &&
      (!Array.isArray(candidate.targets) ||
        candidate.targets.length !== 2 ||
        !candidate.targets.includes("claude") ||
        !candidate.targets.includes("codex"))
    )
      errors.push(
        grammarMessage(
          `${path}.targets`,
          "reviewed control targets must exactly match AIH's shipped projector targets: claude, codex",
        ),
      );
  });
  custom.forEach((candidate, index) => {
    checkCandidate(candidate, `policy.governance.catalog.custom[${index}]`, "custom", errors);
  });
  const candidates = reviewed.concat(custom);
  const candidateIds = candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length)
    errors.push(
      grammarMessage("policy.governance.catalog", "candidate identifiers must be unique"),
    );
  const activations: Loose[] = Array.isArray(governance.activations) ? governance.activations : [];
  const activated = activations.map((activation) => activation.candidate);
  if (new Set(activated).size !== activated.length)
    errors.push(
      grammarMessage("policy.governance.activations", "candidate decisions must be unique"),
    );
  activations.forEach((activation, index) => {
    const candidate = candidates.find((entry) => entry.id === activation.candidate);
    if (candidate) {
      if (
        Array.isArray(activation.targets) &&
        activation.targets.some((target: Loose) => !candidate.targets.includes(target))
      )
        errors.push(
          grammarMessage(
            `policy.governance.activations[${index}]`,
            "targets exceed candidate support",
          ),
        );
    } else {
      errors.push(
        grammarMessage(
          `policy.governance.activations[${index}]`,
          "references an unknown candidate",
        ),
      );
    }
    const control = reviewed.find((entry) => entry.id === activation.candidate);
    if (control && hasSupportedClis) {
      const sanctioned: Loose[] = control.targets.filter((target: Loose) =>
        supportedClis.includes(target),
      );
      if (sanctioned.length === 0) {
        errors.push(
          grammarMessage(
            `policy.governance.activations[${index}].targets`,
            `${activation.candidate} has no projector for the organization-sanctioned CLI set ${supportedClis.join(", ")}; control projector targets: ${control.targets.join(", ")}`,
          ),
        );
      } else if (
        !Array.isArray(activation.targets) ||
        activation.targets.length !== sanctioned.length ||
        sanctioned.some((target) => !activation.targets.includes(target))
      ) {
        errors.push(
          grammarMessage(
            `policy.governance.activations[${index}].targets`,
            `activation targets for ${activation.candidate} must exactly match the organization-sanctioned projector targets: ${sanctioned.join(", ")}`,
          ),
        );
      }
    }
  });
  if (
    activations.filter(
      (activation) =>
        activation.state === "active" &&
        candidates.some(
          (candidate) => candidate.id === activation.candidate && candidate.kind === "framework",
        ),
    ).length > 1
  )
    errors.push(
      grammarMessage("policy.governance.activations", "only one framework intent may be active"),
    );
  const approvals: Loose[] =
    governance.authority && Array.isArray(governance.authority.approvals)
      ? governance.authority.approvals
      : [];
  if (new Set(approvals.map((approval) => approval.id)).size !== approvals.length)
    errors.push(
      grammarMessage(
        "policy.governance.authority.approvals",
        "approval identifiers must be unique",
      ),
    );
  approvals.forEach((approval, index) => {
    const path = `policy.governance.authority.approvals[${index}]`;
    checkCommandArguments(approval.source, `${path}.source`, errors);
    checkIsoTimestamp(approval.notBefore, `${path}.notBefore`, errors);
    checkIsoTimestamp(approval.expiresAt, `${path}.expiresAt`, errors);
  });
  const curation: Loose[] = Array.isArray(governance.externalCuration)
    ? governance.externalCuration
    : [];
  if (new Set(curation.map((record) => record.framework)).size !== curation.length)
    errors.push(
      grammarMessage("policy.governance.externalCuration", "framework records must be unique"),
    );
  curation.forEach((record, index) => {
    const path = `policy.governance.externalCuration[${index}]`;
    const keys = (record.items || []).map((item: Loose) => {
      checkVisibleText(item.id, `${path}.items id`, errors);
      checkRepoRelativePath(item.source && item.source.path, `${path}.items path`, errors);
      checkVisibleText(item.audit && item.audit.record, `${path}.items audit record`, errors);
      if (item.clarification !== undefined)
        checkVisibleText(item.clarification, `${path}.items clarification`, errors);
      // The legacy runtime joins kind and id with the six literal characters
      // backslash-u-0-0-0-0, not a NUL; kept byte-for-byte.
      return `${item.kind}\\u0000${item.id}`;
    });
    if (new Set(keys).size !== keys.length)
      errors.push(grammarMessage(`${path}.items`, "kind/id pairs must be unique"));
  });
  const overrides: Loose[] =
    policy.trust && Array.isArray(policy.trust.baselineOverrides)
      ? policy.trust.baselineOverrides
      : [];
  overrides.forEach((override, index) => {
    checkRepoRelativePath(
      override.bundle,
      `policy.trust.baselineOverrides[${index}].bundle`,
      errors,
    );
    checkIsoTimestamp(
      override.approvedAt,
      `policy.trust.baselineOverrides[${index}].approvedAt`,
      errors,
    );
  });
  return errors;
}

/** Legacy `ot`: free-text governance fields must be visible single-line text. */
export function governanceTextErrors(policy: Loose): string[] {
  const errors: string[] = [];
  const governance = policy?.governance;
  if (!governance || typeof governance !== "object") return errors;
  if (governance.policyVersion !== undefined)
    checkVisibleText(governance.policyVersion, "policy.governance.policyVersion", errors);
  (governance.activations || []).forEach((activation: Loose, index: number) => {
    if (activation.clarification !== undefined)
      checkVisibleText(
        activation.clarification,
        `policy.governance.activations[${index}].clarification`,
        errors,
      );
  });
  ((governance.authority && governance.authority.approvals) || []).forEach(
    (approval: Loose, index: number) => {
      const path = `policy.governance.authority.approvals[${index}]`;
      checkVisibleText(approval.policyVersion, `${path}.policyVersion`, errors);
      checkVisibleText(approval.reason, `${path}.reason`, errors);
      if (approval.clarification !== undefined)
        checkVisibleText(approval.clarification, `${path}.clarification`, errors);
      checkVisibleText(
        approval.github && approval.github.attestationId,
        `${path}.github.attestationId`,
        errors,
      );
    },
  );
  return errors;
}

function isExactHttpsOrigin(value: unknown): boolean {
  try {
    const url = new URL(value as string);
    return (
      typeof value === "string" &&
      value === value.trim() &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** Legacy `et`: package registries are exact HTTPS origins; command args stay safe. */
export function registryOriginErrors(policy: Loose): string[] {
  const errors: string[] = [];
  const checkSource = (source: Loose, path: string): void => {
    if (!source || typeof source !== "object") return;
    if (
      (source.type === "package" || source.type === "stdio") &&
      !isExactHttpsOrigin(source.registry)
    )
      errors.push(grammarMessage(`${path}.registry`, "must be an exact HTTPS origin"));
    if (source.type === "command" && Array.isArray(source.args))
      source.args.forEach((argument: unknown, index: number) => {
        if (!isExactRegistryOriginArgument(argument) && isUnsafeCommandArgument(argument))
          errors.push(grammarMessage(`${path}.args[${index}]`, "must be a safe relative argument"));
      });
  };
  const governance = policy?.governance;
  const catalog = (governance && typeof governance === "object" && governance.catalog) || {};
  for (const list of ["reviewed", "custom"]) {
    (Array.isArray(catalog[list]) ? catalog[list] : []).forEach(
      (candidate: Loose, index: number) => {
        checkSource(
          candidate && candidate.source,
          `policy.governance.catalog.${list}[${index}].source`,
        );
      },
    );
  }
  (governance?.authority && Array.isArray(governance.authority.approvals)
    ? governance.authority.approvals
    : []
  ).forEach((approval: Loose, index: number) => {
    checkSource(
      approval && approval.source,
      `policy.governance.authority.approvals[${index}].source`,
    );
  });
  (policy?.trust && Array.isArray(policy.trust.baselineOverrides)
    ? policy.trust.baselineOverrides
    : []
  ).forEach((override: Loose, index: number) => {
    checkRepoRelativePath(
      override && override.bundle,
      `policy.trust.baselineOverrides[${index}].bundle`,
      errors,
    );
    checkIsoTimestamp(
      override && override.approvedAt,
      `policy.trust.baselineOverrides[${index}].approvedAt`,
      errors,
    );
  });
  return errors;
}

/** The schema plus every grammar pass, in the legacy order (`ie(...).concat(nt, Pe, et, ot)`). */
export function policyGrammarErrors(policy: unknown, model: PolicyGrammarModel): string[] {
  return policySchemaErrors(model.schema, policy, "").concat(
    governanceGrammarErrors(policy, model),
    kiroRemoteMcpErrors(policy),
    registryOriginErrors(policy),
    governanceTextErrors(policy),
  );
}

/** Legacy `ce`: recursively sort object keys. */
export function canonicalizeKeys(value: Loose): Loose {
  return Array.isArray(value)
    ? value.map(canonicalizeKeys)
    : value && typeof value === "object"
      ? Object.keys(value)
          .sort()
          .reduce((sorted: Record<string, unknown>, key) => {
            sorted[key] = canonicalizeKeys(value[key]);
            return sorted;
          }, {})
      : value;
}

/** Legacy `Re`: key-order-insensitive JSON equality. */
export function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeKeys(left)) === JSON.stringify(canonicalizeKeys(right));
}

/** Legacy `Ne`: built-in MCP control candidates by id from the Workbench bindings. */
export function managedMcpCatalogBindings(model: PolicyGrammarModel): Map<string, Loose> {
  const bindings = model.workbenchBindings as Loose;
  if (!bindings || typeof bindings !== "object") return new Map();
  return new Map(
    Object.values(bindings)
      .filter(
        (binding: Loose) =>
          binding &&
          binding.kind === "control" &&
          binding.candidate &&
          binding.candidate.kind === "mcp" &&
          binding.candidate.source &&
          binding.candidate.source.type === "mcp",
      )
      .map((binding: Loose) => [binding.candidate.id, binding.candidate]),
  );
}

function activeCandidateIds(activations: unknown): Set<unknown> {
  return new Set(
    (Array.isArray(activations) ? activations : [])
      .filter((activation: Loose) => activation && activation.state === "active")
      .map((activation: Loose) => activation.candidate),
  );
}

/** Legacy `Ke`: sorted servers of active reviewed built-in MCP controls. */
export function activeManagedMcpServers(policy: Loose): string[] {
  const governance = policy?.governance;
  if (!governance || typeof governance !== "object") return [];
  const reviewed: Loose[] =
    governance.catalog && Array.isArray(governance.catalog.reviewed)
      ? governance.catalog.reviewed
      : [];
  const active = activeCandidateIds(governance.activations);
  return Array.from(
    new Set(
      reviewed
        .filter(
          (candidate) =>
            active.has(candidate.id) &&
            candidate.kind === "mcp" &&
            candidate.source &&
            candidate.source.type === "mcp",
        )
        .map((candidate) => candidate.source.server),
    ),
  ).sort();
}

/** Legacy `N`: schema-2 managed MCP authority must match the prepared catalog exactly. */
export function managedMcpAuthorityErrors(policy: Loose, model: PolicyGrammarModel): string[] {
  if (!model.workbenchBundle)
    return [grammarMessage("policy", "Prepared Workbench catalog is unavailable.")];
  const errors: string[] = [];
  const governance = policy?.governance;
  if (!governance || typeof governance !== "object") return errors;
  const reviewed: Loose[] =
    governance.catalog && Array.isArray(governance.catalog.reviewed)
      ? governance.catalog.reviewed
      : [];
  const active = activeCandidateIds(governance.activations);
  const bindings = managedMcpCatalogBindings(model);
  reviewed.forEach((candidate, index) => {
    if (
      !candidate ||
      !active.has(candidate.id) ||
      candidate.kind !== "mcp" ||
      !candidate.source ||
      candidate.source.type !== "mcp"
    )
      return;
    const path = `policy.governance.catalog.reviewed[${index}]`;
    const bound = bindings.get(candidate.id);
    if (!bound) {
      errors.push(
        grammarMessage(path, `${candidate.id} is not present in the current managed MCP catalog`),
      );
      return;
    }
    if (!sameCanonicalJson(normalizeLegacyCandidateDefaults(candidate), bound))
      errors.push(
        grammarMessage(
          path,
          `${candidate.id} does not exactly match the current managed MCP catalog record`,
        ),
      );
  });
  const selected = reviewed
    .filter(
      (candidate) =>
        candidate &&
        active.has(candidate.id) &&
        candidate.kind === "mcp" &&
        candidate.source &&
        candidate.source.type === "mcp",
    )
    .map((candidate) => candidate.source.server)
    .filter((server, index, all) => all.indexOf(server) === index)
    .sort();
  const mcp = policy.mcp;
  const allowed =
    mcp && Array.isArray(mcp.allowedServers) ? Array.from(new Set(mcp.allowedServers)).sort() : [];
  if (selected.length === 0) {
    if (mcp && (mcp.allowManagedOnly === true || allowed.length))
      errors.push(
        grammarMessage(
          "policy.mcp",
          "center-panel MCP authority is empty, so managed MCP projection must be disabled and its allow-list empty",
        ),
      );
    return errors;
  }
  if (!mcp || mcp.allowManagedOnly !== true)
    errors.push(
      grammarMessage(
        "policy.mcp.allowManagedOnly",
        "selected center-panel MCP controls require managed MCP projection",
      ),
    );
  if (JSON.stringify(allowed) !== JSON.stringify(selected))
    errors.push(
      grammarMessage(
        "policy.mcp.allowedServers",
        `must exactly match selected center-panel MCP controls: ${selected.join(", ")}`,
      ),
    );
  return errors;
}

/** Legacy `oe`: migrate a schema-2 enterprise policy that predates managed MCP projection. */
export function migrateLegacyManagedMcp(
  policy: Loose,
  model: PolicyGrammarModel,
): PreparedPolicyImport | null {
  if (!model.workbenchBundle) return null;
  if (
    !policy ||
    typeof policy !== "object" ||
    Object.hasOwn(policy, "mcp") ||
    policy.minimumPosture !== "enterprise"
  )
    return null;
  const governance = policy.governance;
  if (
    !governance ||
    typeof governance !== "object" ||
    !governance.catalog ||
    !Array.isArray(governance.catalog.reviewed) ||
    !Array.isArray(governance.activations)
  )
    return null;
  const active = new Map<unknown, Loose>(
    governance.activations
      .filter((activation: Loose) => activation && activation.state === "active")
      .map((activation: Loose) => [activation.candidate, activation]),
  );
  const controls: Loose[] = governance.catalog.reviewed.filter(
    (candidate: Loose) =>
      candidate &&
      candidate.kind === "mcp" &&
      candidate.source &&
      candidate.source.type === "mcp" &&
      active.has(candidate.id),
  );
  if (controls.length === 0) return null;
  const requested =
    /^Requested by: (?:enterprise profile|administrator)(?:, (?:enterprise profile|administrator))*$/;
  if (
    !controls.some((control) => {
      const activation = active.get(control.id);
      const clarification = String(activation?.clarification || "");
      return (
        clarification.indexOf("Requested by: ") === 0 &&
        clarification.slice(14).split(", ").includes("enterprise profile")
      );
    }) ||
    !controls.every((control) => {
      const activation = active.get(control.id);
      return activation && requested.test(String(activation.clarification || ""));
    })
  )
    return null;
  const bindings = managedMcpCatalogBindings(model);
  const bundle = model.workbenchBundle as Loose;
  const requestAssets = new Map<unknown, Loose>(
    Object.values(bundle.assets || {})
      .filter((asset: Loose) => asset?.authoring && asset.authoring.action === "record-request")
      .map((asset: Loose) => [asset.label, asset]),
  );
  const servers: string[] = [];
  const unavailable: string[] = [];
  for (const control of controls) {
    const bound = bindings.get(control.id);
    if (!bound) {
      unavailable.push(control.id);
      continue;
    }
    const expected = {
      id: bound.id,
      kind: bound.kind,
      description: "AIH-provided governed control",
      capabilities: [],
      risks: [],
      source: bound.source,
      targets: bound.targets,
      projector: bound.projector,
      lifecycle: bound.lifecycle,
      evidence: { record: `aih-${bound.id}` },
      findings: [],
      autoExecute: false,
    };
    if (!sameCanonicalJson(normalizeLegacyCandidateDefaults(control), expected)) return null;
    const activation = active.get(control.id);
    if (
      !sameCanonicalJson(activation, {
        candidate: bound.id,
        state: "active",
        targets: bound.targets,
        clarification: activation.clarification,
      })
    )
      return null;
    servers.push(bound.source.server);
  }
  const migrated = structuredClone(policy);
  if (unavailable.length) {
    const removed = new Set(unavailable);
    migrated.governance.catalog.reviewed = migrated.governance.catalog.reviewed.filter(
      (candidate: Loose) => !removed.has(candidate.id),
    );
    migrated.governance.activations = migrated.governance.activations.filter(
      (activation: Loose) => !removed.has(activation.candidate),
    );
  }
  if (servers.length)
    migrated.mcp = {
      allowedServers: Array.from(new Set(servers)).sort(),
      allowManagedOnly: true,
    };
  const requestedOnly = unavailable.filter((id) => requestAssets.has(id)).sort();
  const nonProjectable = unavailable.filter((id) => !requestAssets.has(id)).sort();
  const suffix =
    (nonProjectable.length
      ? `; non-projectable MCP authority removed: ${nonProjectable.join(", ")}`
      : "") +
    (requestedOnly.length
      ? `; unavailable AIH-owned MCP authority removed: ${requestedOnly.join(", ")} (no current protected Scanner evidence record)`
      : "");
  const message = `Legacy Workbench policy migrated: managed MCP projection restored${
    servers.length
      ? ` for ${Array.from(new Set(servers)).sort().join(", ")}`
      : " with no projectable MCP authority"
  }${suffix}. Review and download this migrated policy.`;
  return { policy: migrated, message };
}

/** Legacy `ze`: narrow schema-2 activation targets to the sanctioned projector intersection. */
export function narrowLegacyActivationTargets(
  policy: Loose,
  model: PolicyGrammarModel,
): PreparedPolicyImport | null {
  if (!policy || typeof policy !== "object") return null;
  const governance = policy.governance;
  if (
    !governance ||
    typeof governance !== "object" ||
    !Array.isArray(governance.supportedClis) ||
    !governance.supportedClis.length ||
    !governance.catalog ||
    !Array.isArray(governance.catalog.reviewed) ||
    !Array.isArray(governance.activations)
  )
    return null;
  const reviewed = new Map<unknown, Loose>(
    governance.catalog.reviewed.map((candidate: Loose) => [candidate.id, candidate]),
  );
  const controls: Loose[] = Object.values((model.workbenchBindings as Loose) || {})
    .map((binding: Loose) => (binding && binding.kind === "control" ? binding.candidate : null))
    .filter(Boolean);
  const migrated = structuredClone(policy);
  const narrowed: string[] = [];
  migrated.governance.activations.forEach((activation: Loose) => {
    const candidate = reviewed.get(activation.candidate);
    const control = controls.find(
      (entry) =>
        entry.id === activation.candidate &&
        sameCanonicalJson(normalizeLegacyCandidateDefaults(candidate), entry),
    );
    if (
      !candidate ||
      !control ||
      !Array.isArray(control.targets) ||
      !sameCanonicalJson(activation.targets, control.targets)
    )
      return;
    const sanctioned = control.targets.filter((target: Loose) =>
      governance.supportedClis.includes(target),
    );
    if (sanctioned.length && sanctioned.length < control.targets.length) {
      activation.targets = sanctioned;
      narrowed.push(control.id);
    }
  });
  return narrowed.length
    ? {
        policy: migrated,
        message: `Legacy Workbench policy migrated: activation targets narrowed to the sanctioned projector intersection for ${narrowed.join(", ")}. Catalog support metadata and imported authority records were preserved; review and download the migrated policy.`,
      }
    : null;
}

/** Legacy `he`: the selection engine must accept the policy. Throws otherwise. */
export function assertSelectionAccepted(policy: unknown, context: PolicyGrammarContext): void {
  const validate = context.selectionValidator();
  if (typeof validate !== "function")
    throw new Error("Workbench selection validation is unavailable.");
  const result = validate(policy) as Loose;
  if (!result || result.accepted !== true) {
    const diagnostics: string[] =
      result && Array.isArray(result.diagnostics) ? result.diagnostics : [];
    throw new Error(
      diagnostics.length
        ? diagnostics.slice(0, 3).join("; ")
        : "Workbench selection state is invalid.",
    );
  }
}

/**
 * Legacy `preparePolicyImport`: migrate, validate, and accept one policy.
 * Throws with at most three diagnostics joined by "; ".
 */
export function preparePolicyImport(
  policy: Loose,
  validate: (policy: Loose) => string[],
  context: PolicyGrammarContext,
): PreparedPolicyImport {
  const { model } = context;
  if (
    model.workbenchBundle &&
    policy &&
    typeof policy === "object" &&
    (policy.schemaVersion === 2 || policy.schemaVersion === 3)
  ) {
    const managed = policy.schemaVersion === 2 ? migrateLegacyManagedMcp(policy, model) : null;
    const narrowed =
      policy.schemaVersion === 2
        ? narrowLegacyActivationTargets(managed ? managed.policy : policy, model)
        : null;
    const prepared = narrowed ? narrowed.policy : managed ? managed.policy : policy;
    const errors = policySchemaErrors(model.schema, prepared, "").concat(
      governanceGrammarErrors(prepared, model),
      prepared.schemaVersion === 2 ? managedMcpAuthorityErrors(prepared, model) : [],
      kiroRemoteMcpErrors(prepared),
      registryOriginErrors(prepared),
      governanceTextErrors(prepared),
    );
    if (errors.length) throw new Error(errors.slice(0, 3).join("; "));
    assertSelectionAccepted(prepared, context);
    return {
      policy: prepared,
      message:
        [managed?.message, narrowed?.message].filter(Boolean).join(" ") ||
        "Policy imported without transformation after prepared Workbench catalog.",
    };
  }
  const messages: string[] = [];
  const managed =
    policy && policy.schemaVersion === 2 ? migrateLegacyManagedMcp(policy, model) : null;
  let prepared = managed ? managed.policy : policy;
  if (managed) messages.push(managed.message);
  const narrowed =
    prepared && prepared.schemaVersion === 2
      ? narrowLegacyActivationTargets(prepared, model)
      : null;
  if (narrowed) {
    prepared = narrowed.policy;
    messages.push(narrowed.message);
  }
  const errors = validate(prepared);
  if (errors.length) throw new Error(errors.slice(0, 3).join("; "));
  assertSelectionAccepted(prepared, context);
  return {
    policy: prepared,
    message: messages.length
      ? messages.join(" ")
      : "Policy imported without transformation after schema and policy-grammar validation.",
  };
}

/** Legacy `validateCurrentPolicy` body: every import check, as a list of at most one message. */
export function validatePolicy(policy: unknown, context: PolicyGrammarContext): string[] {
  try {
    preparePolicyImport(
      policy,
      (candidate) => policyGrammarErrors(candidate, context.model),
      context,
    );
    return [];
  } catch (error) {
    return [(error as Loose)?.message ? (error as Loose).message : "Policy validation failed."];
  }
}

/**
 * Legacy `Ye`: bring `policy.mcp` in line with the active managed MCP controls.
 * Mutates `policy` in place, exactly as the legacy runtime mutated its state.
 */
export function reconcileManagedMcpProjection(policy: Loose, managedMcpOptIn: boolean): void {
  if (policy && policy.schemaVersion !== 2 && policy.schemaVersion !== 3) return;
  const servers = activeManagedMcpServers(policy);
  if (servers.length) {
    if (!managedMcpOptIn) return;
    policy.mcp = Object.assign({}, policy.mcp || {}, {
      allowedServers: servers,
      allowManagedOnly: true,
    });
    return;
  }
  if (!policy.mcp) return;
  const mcp = policy.mcp;
  if (
    (Array.isArray(mcp.approvals) && mcp.approvals.length > 0) ||
    (Array.isArray(mcp.incumbentHosts) && mcp.incumbentHosts.length > 0) ||
    typeof mcp.githubHost === "string" ||
    (Array.isArray(mcp.disabledServers) && mcp.disabledServers.length > 0)
  )
    policy.mcp = Object.assign({}, mcp, { allowedServers: [], allowManagedOnly: false });
  else delete policy.mcp;
}

/** Legacy `Qe`: deployment setup still owed before export or download. */
export function deploymentReadinessBlockers(policy: Loose, managedMcpOptIn: boolean): string[] {
  const governance = governanceOrDefault(policy.governance);
  const reviewed: Loose[] =
    governance.catalog && Array.isArray(governance.catalog.reviewed)
      ? governance.catalog.reviewed
      : [];
  const active = activeCandidateIds(governance.activations);
  const blockers: string[] = [];
  const selected = reviewed.filter(
    (candidate) =>
      active.has(candidate.id) && (candidate.kind === "mcp" || candidate.kind === "hook"),
  );
  if (!selected.length) return blockers;
  if (activeManagedMcpServers(policy).length && !managedMcpOptIn)
    blockers.push("enable managed MCP projection");
  return blockers;
}
