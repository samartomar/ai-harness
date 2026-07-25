# Conditional Node TLS Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect OS-pass/Node-fail TLS divergence and persist only a system-CA or minimal OS-root configuration that a Node candidate probe verifies.

**Architecture:** Extend the existing `heal`, `certs`, host-adapter, runner, and CLI-registry seams. `heal` compares OS-native and Node handshakes for the same bounded origins, tests the narrowest candidate, and emits local actions only for a passing candidate; `certs` reuses the platform persistence helper for explicit extraction.

**Tech Stack:** TypeScript ESM, Node `tls`/`X509Certificate`, Vitest fake runners, existing plan/action executor, Biome, npm.

## Global Constraints

- Add no command, flag, JSON-envelope key, dependency, or incompatible owned-file schema.
- Keep every network operation a bounded read-only probe against reviewed HTTPS origins.
- Never disable TLS or hostname verification when deciding whether a candidate passes.
- Never trust a certificate obtained only from the served peer chain.
- Persist only a candidate that passed a Node probe for every divergent origin.
- Keep mutations local, dry-run visible, and gated by `--apply`.
- Do not publish external logs, organization identifiers, private endpoint data, or attachment text.
- Sign off every commit with DCO; do not add AI-attribution trailers.

## File Structure

- Create `src/heal/node-trust.ts`: Node TLS probe, peer-chain metadata capture, trusted-root matching, and conditional candidate selection.
- Create `src/certs/node-env.ts`: shared Node trust environment values and platform persistence actions.
- Modify `src/heal/common.ts`: add typed shared runtime TLS observations.
- Modify `src/heal/index.ts`: collect bounded origins and compute OS/Node observations once.
- Modify `src/heal/cert-verify.ts`: classify divergence and plan only the selected repair.
- Modify `src/internals/cli-registry.ts`: keep optional public runtime TLS origins in the existing per-CLI source of truth.
- Modify `src/platform/base.ts`: expose read-only enumeration of all OS-trusted roots.
- Modify `src/platform/windows.ts`, `src/platform/darwin.ts`, `src/platform/linux.ts`: implement all-root enumeration through existing OS seams.
- Modify `src/certs/index.ts`: add system-CA environment propagation, shared GUI persistence, and Node verification after apply.
- Modify `src/heal/templates.ts`: describe conditional runtime repair and required GUI relaunch.
- Create `tests/heal/node-trust.test.ts`: pure candidate and X.509 selection cases.
- Modify `tests/heal/heal.test.ts`: end-to-end plan behavior and RED/GREEN divergence cases.
- Modify `tests/certs/certs.test.ts`: explicit certs propagation and persistence behavior.
- Modify `tests/platform/windows.test.ts`, `tests/platform/darwin.test.ts`, `tests/platform/linux.test.ts`: all-root enumeration and platform persistence fixtures.
- Modify `tests/internals/cli-registry.test.ts`: registry origin validation and deterministic ordering.
- Modify `docs/commands.md` and `CHANGELOG.md`: public behavior and `[Unreleased]` fix note.

---

### Task 1: Detect OS/Node TLS Divergence

**Files:**
- Modify: `src/internals/cli-registry.ts`
- Modify: `src/heal/common.ts`
- Modify: `src/heal/index.ts`
- Create: `src/heal/node-trust.ts`
- Modify: `tests/internals/cli-registry.test.ts`
- Modify: `tests/heal/heal.test.ts`

**Interfaces:**
- Produces: `RuntimeTlsObservation { origin: string; os: Check; node: Check }`.
- Produces: `probeNodeTls(ctx: PlanContext, origin: string, env?: NodeJS.ProcessEnv): Promise<Check>`.
- Produces: `runtimeTlsOrigins(ctx: PlanContext): string[]`.
- Extends: `HealShared.runtimeTls: readonly RuntimeTlsObservation[]`.

- [ ] **Step 1: Write the failing registry and heal tests**

Add an optional validated registry field:

```ts
tlsOrigins: z.array(z.string().url()).optional(),
```

Add a registry test that parses only HTTPS, credential-free origins and keeps
the configured order:

```ts
it("keeps reviewed runtime TLS origins in the CLI registry", () => {
  const origins = entry("kiro").tlsOrigins ?? [];
  expect(origins.length).toBeGreaterThan(0);
  for (const origin of origins) {
    const url = new URL(origin);
    expect(url.protocol).toBe("https:");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.pathname).toBe("/");
  }
});
```

Extend the heal fixture with independent `nodeRegistry` and `nodePypi` states,
then add the core regression:

```ts
it("fails when OS TLS passes but Node TLS fails", async () => {
  const p = await command.plan(
    makeCtx({
      root: freshTmp(),
      ca: "unset",
      registry: "ok",
      pypi: "ok",
      nodeRegistry: "fail",
      nodePypi: "fail",
    }),
  );
  expect(findCheck(p.actions, "Node TLS registry.npmjs.org")?.verdict).toBe("fail");
  expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")?.verdict).toBe("fail");
});
```

- [ ] **Step 2: Run the RED target**

Run:

```bash
npm test -- --run tests/internals/cli-registry.test.ts tests/heal/heal.test.ts
```

Expected: the new tests execute and fail because `tlsOrigins`,
`RuntimeTlsObservation`, and Node core-origin checks do not exist.

- [ ] **Step 3: Commit the RED checkpoint**

```bash
git add tests/internals/cli-registry.test.ts tests/heal/heal.test.ts
git -c commit.gpgsign=false commit -s -m "test: reproduce OS and Node TLS divergence"
```

- [ ] **Step 4: Implement bounded origin selection and Node probing**

In `src/internals/cli-registry.ts`, add `tlsOrigins` to `CliEntry` and populate
only reviewed public HTTPS origins for entries that document stable health
origins.

In `src/heal/node-trust.ts`, add:

```ts
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";

const NODE_TLS_SCRIPT =
  "const tls=require('node:tls');const u=new URL(process.argv[1]);" +
  "const h=u.hostname.replace(/^\\[(.*)\\]$/,'$1');" +
  "const s=tls.connect({host:h,port:Number(u.port||443),servername:h,timeout:20000}," +
  "()=>{s.end();process.exit(0)});" +
  "s.on('error',()=>process.exit(1));" +
  "s.on('timeout',()=>{s.destroy();process.exit(1)})";

export interface RuntimeTlsObservation {
  origin: string;
  os: Check;
  node: Check;
}

export async function probeNodeTls(
  ctx: PlanContext,
  origin: string,
  env: NodeJS.ProcessEnv = ctx.env,
): Promise<Check> {
  const host = new URL(origin).host;
  const result = await ctx.run(["node", "-e", NODE_TLS_SCRIPT, origin], {
    env,
    timeoutMs: 25_000,
  });
  if (result.spawnError && !/timed out/i.test(result.stderr)) {
    return { name: `cert: Node TLS ${host}`, verdict: "skip", detail: "node not found on PATH" };
  }
  return result.code === 0
    ? { name: `cert: Node TLS ${host}`, verdict: "pass", detail: `Node handshake to ${host} OK` }
    : {
        name: `cert: Node TLS ${host}`,
        verdict: "fail",
        code: "tls.verify-failed",
        detail: `Node TLS verification failed for ${host}`,
      };
}
```

Add a `runtimeTlsOrigins(ctx)` helper that:

- starts with `REGISTRY_URL` and `PYPI_URL`;
- reads `ctx.targets` or validated `.aih-config.json` targets;
- appends `entry(cli).tlsOrigins`;
- accepts only HTTPS origins without credentials;
- deduplicates in insertion order and caps the result at six.

In `src/heal/index.ts`, compute one OS check and one Node check per origin with
`Promise.all`, reuse the registry/PyPI OS results for existing npm/cert steps,
and pass the observations through `HealShared.runtimeTls`.

In `src/heal/cert-verify.ts`, make any OS-pass/Node-fail observation a failing
CA check even when `NODE_EXTRA_CA_CERTS` is unset.

- [ ] **Step 5: Run the GREEN target**

Run:

```bash
npm test -- --run tests/internals/cli-registry.test.ts tests/heal/heal.test.ts
```

Expected: both files pass, including the original unset-env/no-proxy case where
OS and Node both pass.

- [ ] **Step 6: Commit the GREEN checkpoint**

```bash
git add src/internals/cli-registry.ts src/heal/common.ts src/heal/index.ts src/heal/node-trust.ts tests/internals/cli-registry.test.ts tests/heal/heal.test.ts
git -c commit.gpgsign=false commit -s -m "fix: detect Node TLS trust divergence"
```

### Task 2: Select a Proven System-CA or Minimal Root Candidate

**Files:**
- Modify: `src/platform/base.ts`
- Modify: `src/platform/windows.ts`
- Modify: `src/platform/darwin.ts`
- Modify: `src/platform/linux.ts`
- Modify: `src/heal/node-trust.ts`
- Modify: `src/heal/cert-verify.ts`
- Create: `tests/heal/node-trust.test.ts`
- Modify: `tests/platform/windows.test.ts`
- Modify: `tests/platform/darwin.test.ts`
- Modify: `tests/platform/linux.test.ts`

**Interfaces:**
- Produces: `HostAdapter.trustStoreRoots(): Promise<CertEntry[]>`.
- Produces: `NodeTrustCandidate`, discriminated as `system-ca`, `extra-ca`, or `unresolved`.
- Produces: `selectNodeTrustCandidate(ctx, divergentOrigins): Promise<NodeTrustCandidate>`.

- [ ] **Step 1: Write failing root-inventory and candidate tests**

Use real parseable certificates generated once as committed public test
fixtures under `tests/fixtures/certs/`; include only test keys/certificates with
subjects such as `Example Test Root A`.

Add:

```ts
it("selects system CA before evaluating an extra bundle", async () => {
  const calls: NodeJS.ProcessEnv[] = [];
  const candidate = await selectNodeTrustCandidate(
    candidateCtx((opts) => {
      calls.push(opts?.env ?? {});
      return calls.length === 1 ? tlsFail() : tlsPass();
    }),
    ["https://runtime.example.test"],
  );
  expect(candidate).toEqual({ kind: "system-ca" });
  expect(calls.at(-1)?.NODE_USE_SYSTEM_CA).toBe("1");
});

it("selects only OS-trusted roots that issue the served chain", async () => {
  const candidate = await selectNodeTrustCandidate(
    candidateCtxWithRoots([ROOT_A, ROOT_B], CHAIN_A),
    ["https://runtime.example.test"],
  );
  expect(candidate.kind).toBe("extra-ca");
  if (candidate.kind === "extra-ca") {
    expect(candidate.certs.map((cert) => cert.subject)).toEqual(["CN=Example Test Root A"]);
  }
});

it("returns unresolved when no verified candidate passes", async () => {
  const candidate = await selectNodeTrustCandidate(
    alwaysFailingCandidateCtx(),
    ["https://runtime.example.test"],
  );
  expect(candidate).toEqual({ kind: "unresolved" });
});
```

Add per-platform tests that `trustStoreRoots()` enumerates all root entries
without a subject pattern and deduplicates identical PEM blocks.

- [ ] **Step 2: Run the RED target**

Run:

```bash
npm test -- --run tests/heal/node-trust.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts tests/platform/linux.test.ts
```

Expected: compile-time RED for the missing `trustStoreRoots` and candidate
selection interfaces.

- [ ] **Step 3: Commit the RED checkpoint**

```bash
git add tests/heal/node-trust.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts tests/platform/linux.test.ts tests/fixtures/certs
git -c commit.gpgsign=false commit -s -m "test: specify conditional Node trust candidates"
```

- [ ] **Step 4: Implement all-root enumeration**

Add to `HostAdapter`:

```ts
/** Public CA certificates from the OS trusted-root stores; read-only and deduplicated. */
trustStoreRoots(): Promise<CertEntry[]>;
```

Implement it per platform:

- Windows: enumerate `Cert:\CurrentUser\Root` and `Cert:\LocalMachine\Root`,
  output raw DER base64 plus subject, parse with `parseCertLines`, and deduplicate
  by PEM.
- macOS: call `security find-certificate -a -p` for login, System, and
  SystemRoot keychains without `-c`, parse all complete PEM blocks, and
  deduplicate by PEM.
- Linux: prefer readable consolidated bundles
  `/etc/ssl/certs/ca-certificates.crt` and `/etc/pki/tls/certs/ca-bundle.crt`;
  otherwise parse PEM blocks from the existing anchor directories. Deduplicate
  by PEM and skip unreadable files.

Retain `trustStoreCerts(pattern)` for the explicit command and implement its
existing behavior without widening the subject match.

- [ ] **Step 5: Implement candidate selection**

Add:

```ts
export type NodeTrustCandidate =
  | { kind: "system-ca" }
  | { kind: "extra-ca"; certs: CertEntry[] }
  | { kind: "unresolved" };
```

Candidate order:

1. Probe every divergent origin with:

```ts
{ ...ctx.env, NODE_USE_SYSTEM_CA: "1" }
```

2. If any origin still fails, capture the peer chain with a bounded Node script
using `rejectUnauthorized:false` only to return base64 DER certificate metadata.
Do not classify that capture as a successful TLS check.
3. Parse chain and root entries using `node:crypto` `X509Certificate`.
4. Reject malformed roots, roots with `ca !== true`, and roots whose validity
window excludes the current time.
5. Match a root subject to the final served certificate issuer/subject, order
matches by `fingerprint256`, and deduplicate.
6. Test the matched roots inline by passing
`[...tls.rootCertificates, ...candidatePem]` as the explicit `ca` list while
retaining hostname verification.
7. Return `extra-ca` only when all divergent origins pass; otherwise return
`unresolved`.

In `cert-verify.ts`, keep unresolved divergence as a failure with diagnostic
guidance and emit no persistence actions.

- [ ] **Step 6: Run the GREEN target**

Run:

```bash
npm test -- --run tests/heal/node-trust.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts tests/platform/linux.test.ts tests/heal/heal.test.ts
```

Expected: candidate, platform, and integrated heal tests pass.

- [ ] **Step 7: Commit the GREEN checkpoint**

```bash
git add src/platform/base.ts src/platform/windows.ts src/platform/darwin.ts src/platform/linux.ts src/heal/node-trust.ts src/heal/cert-verify.ts tests/heal/node-trust.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts tests/platform/linux.test.ts tests/heal/heal.test.ts tests/fixtures/certs
git -c commit.gpgsign=false commit -s -m "fix: select a verified Node trust candidate"
```

### Task 3: Persist Only the Selected Configuration

**Files:**
- Create: `src/certs/node-env.ts`
- Modify: `src/certs/index.ts`
- Modify: `src/heal/cert-verify.ts`
- Modify: `src/heal/templates.ts`
- Modify: `tests/certs/certs.test.ts`
- Modify: `tests/heal/heal.test.ts`
- Modify: `tests/platform/windows.test.ts`
- Modify: `tests/platform/darwin.test.ts`

**Interfaces:**
- Produces: `nodeTrustEnvVars(extraCaPath?: string): EnvVar[]`.
- Produces: `nodeTrustPersistenceActions(ctx, vars): Action[]`.
- Produces: `macLaunchAgentPlist(label, key, value): string`.

- [ ] **Step 1: Write failing persistence tests**

Add:

```ts
it("explicit certs propagates system CA plus the selected extra bundle", async () => {
  const block = findEnvBlock((await command.plan(makeCtx({ root: freshTmp() }))).actions, "certs");
  expect(block?.vars).toEqual(
    expect.arrayContaining([
      { key: "NODE_USE_SYSTEM_CA", value: "1" },
      expect.objectContaining({ key: "NODE_EXTRA_CA_CERTS" }),
    ]),
  );
});

it("Windows certs persists both Node values directly", async () => {
  const p = await command.plan(makeCtx({ root: freshTmp(), platform: "windows" }));
  const setx = p.actions.filter(
    (action): action is Extract<Action, { kind: "exec" }> =>
      action.kind === "exec" && action.argv[0] === "setx",
  );
  expect(setx.map((action) => action.argv.slice(0, 2))).toEqual([
    ["setx", "NODE_USE_SYSTEM_CA"],
    ["setx", "NODE_EXTRA_CA_CERTS"],
  ]);
});

it("macOS writes escaped deterministic LaunchAgents and updates launchd", async () => {
  const p = await command.plan(
    makeCtx({ root: freshTmp(), platform: "darwin", env: { HOME: "/Users/R&D" } }),
  );
  const plists = p.actions.filter(
    (action): action is Extract<Action, { kind: "write" }> =>
      action.kind === "write" && action.path.endsWith(".plist"),
  );
  expect(plists).toHaveLength(2);
  expect(plists[0]?.contents).toContain("&amp;");
  expect(plists[0]?.contents).not.toContain("/bin/sh");
  expect(plists.map((action) => action.contents)).toEqual(
    [...plists.map((action) => action.contents)].sort(),
  );
});
```

Add heal tests proving `system-ca` persists only `NODE_USE_SYSTEM_CA`, while
`extra-ca` writes and locks a deterministic PEM then persists only
`NODE_EXTRA_CA_CERTS`.

- [ ] **Step 2: Run the RED target**

Run:

```bash
npm test -- --run tests/certs/certs.test.ts tests/heal/heal.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts
```

Expected: failures for missing system-CA propagation, shared persistence
actions, and macOS LaunchAgents.

- [ ] **Step 3: Commit the RED checkpoint**

```bash
git add tests/certs/certs.test.ts tests/heal/heal.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts
git -c commit.gpgsign=false commit -s -m "test: specify conditional GUI trust persistence"
```

- [ ] **Step 4: Implement shared environment and persistence actions**

In `src/certs/node-env.ts`:

```ts
export const NODE_USE_SYSTEM_CA = "NODE_USE_SYSTEM_CA";
export const NODE_EXTRA_CA_CERTS = "NODE_EXTRA_CA_CERTS";

export function nodeTrustEnvVars(extraCaPath?: string): EnvVar[] {
  return [
    { key: NODE_USE_SYSTEM_CA, value: "1" },
    ...(extraCaPath ? [{ key: NODE_EXTRA_CA_CERTS, value: extraCaPath }] : []),
  ];
}
```

`nodeTrustPersistenceActions(ctx, vars)` must:

- return direct `setx` exec actions on Windows, preserving the 1,024-character
  value guard and existing failure checks;
- return one direct `launchctl setenv <key> <value>` exec plus one deterministic
  `~/Library/LaunchAgents/dev.aih.env.<normalized-key>.plist` write per variable
  on macOS;
- return no exec/write actions on Linux because the existing shell env block is
  the supported persistence seam.

Each macOS plist uses `/bin/launchctl` with literal `ProgramArguments`; XML
escape `&`, `<`, `>`, `"`, and `'`. Do not invoke a shell.

- [ ] **Step 5: Wire selected persistence into heal and explicit certs**

For `system-ca`, add a managed shell-profile env block containing only
`NODE_USE_SYSTEM_CA=1`, then append shared persistence actions.

For `extra-ca`, write the stable bundle to
`~/.config/enterprise-ca/corporate-root-ca.pem`, lock it with the host adapter,
add a managed shell-profile env block containing only `NODE_EXTRA_CA_CERTS`,
then append shared persistence actions.

For explicit `certs`, retain every existing trust variable and add
`NODE_USE_SYSTEM_CA=1`; append shared persistence for the two Node variables.

Under apply, add a final Node probe that receives the selected persisted
environment and verifies every divergent origin after writes/execs. In dry-run,
report the already completed candidate result and label packaged GUI
applications as requiring relaunch verification.

- [ ] **Step 6: Run the GREEN target**

Run:

```bash
npm test -- --run tests/certs/certs.test.ts tests/heal/heal.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts
```

Expected: all explicit and conditional persistence tests pass.

- [ ] **Step 7: Commit the GREEN checkpoint**

```bash
git add src/certs/node-env.ts src/certs/index.ts src/heal/cert-verify.ts src/heal/templates.ts tests/certs/certs.test.ts tests/heal/heal.test.ts tests/platform/windows.test.ts tests/platform/darwin.test.ts
git -c commit.gpgsign=false commit -s -m "fix: persist verified Node trust settings"
```

### Task 4: Documentation and Compatibility

**Files:**
- Modify: `docs/commands.md`
- Modify: `CHANGELOG.md`
- Test: `tests/contract/command-surface.test.ts`

**Interfaces:**
- Consumes: completed behavior from Tasks 1–3.
- Produces: public-safe command documentation with no CLI-surface drift.

- [ ] **Step 1: Update public documentation**

Add an `[Unreleased]` `### Fixed` entry:

```md
- `aih heal` now distinguishes OS-native TLS success from Node runtime trust,
  tests system trust before a minimal OS-root fallback, and persists only a
  candidate that verifies; `aih certs` also propagates GUI-safe Node trust on
  Windows and macOS. (#512)
```

Update `docs/commands.md` to state:

- OS and Node handshakes are compared for the same bounded origins;
- system trust is tried before minimal matched roots;
- local persistence occurs only under `--apply`;
- GUI applications require a full relaunch;
- packaged application behavior remains operator-verified.

- [ ] **Step 2: Verify docs and stable command surface**

Run:

```bash
npm run docs:lint
npm test -- --run tests/contract/command-surface.test.ts
git diff -- tests/contract/command-surface.json
```

Expected: docs lint and contract test pass; the command-surface JSON has no
diff.

- [ ] **Step 3: Commit documentation**

```bash
git add CHANGELOG.md docs/commands.md
git -c commit.gpgsign=false commit -s -m "docs: explain conditional Node trust repair"
```

### Task 5: Full Gate, Specialized Reviews, and PR

**Files:**
- Review: all files changed from `origin/main`
- Update only if a review finding requires a scoped correction.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified, reviewed, public-safe pull request closing #512.

- [ ] **Step 1: Run the full completion gate**

Run:

```bash
npm run verify
git diff --check origin/main...HEAD
git status --short
```

Expected: `npm run verify` exits 0; diff check is empty; the worktree is clean.

- [ ] **Step 2: Run specialized reviews**

Dispatch independent agents against `origin/main...HEAD`:

- correctness reviewer: plan/action ordering, typed checks, and regression
  behavior;
- security reviewer: TLS verification, chain capture, X.509 matching,
  subprocess/env safety, and public-data boundaries;
- platform reviewer: Windows trust stores/setx, macOS launchd/plists, Linux
  trust bundles, escaping, and idempotency.

Each reviewer must cite exact files/lines and classify findings by severity.
Remediate every critical/high finding and every correctness defect; rerun the
focused target and `npm run verify` after any production change.

- [ ] **Step 3: Audit public content**

Run a diff-only scan for:

```text
organization names, private domains, workstation usernames, attachment paths,
external log fragments, proxy-vendor-specific incident text, credentials
```

Inspect issue #512, commit subjects, branch name, changelog, docs, tests, and PR
body. Existing repository references outside the diff are not findings.

- [ ] **Step 4: Push and open the ready PR**

```bash
git push -u origin agent/issue-512-node-tls-trust
```

Open a non-draft PR to `main` with:

```md
## Summary

- distinguish OS and Node TLS trust
- apply only a verified system-CA or minimal-root candidate
- persist selected Node trust for supported GUI environments

## Validation

- `npm run verify`
- correctness, security, and platform reviews completed

Closes #512

Semver: patch
```

- [ ] **Step 5: Inspect PR checks and review state**

Poll the PR check rollup to a terminal state. Read any failure before changing
code. If a scoped correction is required, commit it with DCO sign-off, push,
rerun the local gate, and re-check CI. Do not merge without a separate explicit
merge instruction.
