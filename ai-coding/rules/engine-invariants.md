# Engine invariants

> Load when: editing `src/` — engines, checks, plans, trust, writers.

Load-bearing seams in `src/`. The broad model (pure `plan()`, seven action kinds,
deterministic output, no remote mutation) lives in `CONTRIBUTING.md`,
`docs/ARCHITECTURE.md`, `SECURITY.md`, and `STABILITY.md` — read those. These are
the specific seams reviews keep missing; verify each against the code before
relying on it.

- **Reuse before building.** Scan / classify / plan / merge machinery already
  exists (`src/profile`, `src/secrets`, `src/adopt`, `src/internals`,
  `src/guardrails`) — a parallel re-implementation is a defect.
- **One source of truth per concern.** Per-CLI facts live in
  `src/internals/cli-registry.ts`, never a parallel `Record<Cli, …>`. One writer
  per file — compose settings by merge, not overwrite.
- **`plan()` is pure and read-only; writes and execs run before probes.** A plan
  can never gate its own writes on its own probes. Widen the plan-purity allowlist
  only alongside its test in the same PR.
- **Fail closed on hostile input, skip on absent tooling.** Unparseable
  security-relevant input (frontmatter, manifests, policy) fails closed; missing
  tools/network/artifacts and spawn errors skip, so a fresh repo exits 0. Route
  findings by typed code, never by matching `detail` text.
- **Never execute an untrusted source.** The scanner only reads files — no
  install, no running its scripts, no fetching its URLs. Acquire as a tarball at a
  pinned SHA into a quarantine dir; parse structurally; contain symlinks (in-tree
  allowed, escaping refused) rather than blanket-refusing. Preserve proxy/CA env
  when scrubbing (`scrubFetchEnv`) — the target runs behind corporate proxies.
- **`.aih/` is disposable, gitignored runtime data — never a source of truth.**
  Committed intent lives at the repo root. Probe ignore state with
  `git check-ignore`, not `existsSync`.
- **Exit codes are binary and flip only through the verification report**, never a
  raw `process.exit`; richer verdicts travel in `--json`. Any command string
  emitted in output must be runnable (it parses against the command-surface
  fixture).
- **Contract synthesis states facts, never inferences** — a build/start command is
  detected or omitted, never invented; the compiler never deletes user files.
- **External support tickets are tool-neutral and canned** — fixed structure,
  each field filled per typed code, never mentioning aih or branching on `detail`.
- **A parent workspace writes only its own bridge files** and reads child repos
  read-only; a malformed manifest degrades to a status, never a crash.
- **Some asymmetries are deliberate — don't "normalize" them.** The secrets scan
  ignores gitignore; posture floors clamp upward only; doctor stays read-only
  (remediation rides in `detail`, no `--fix`). The sandbox probe fails open by
  design, and several hardening decisions are parked — don't implement them
  unilaterally.
- **Porting code:** verify the on-disk LICENSE before attributing; re-express
  models, copy no bodies; pin new deps to an exact version.
- **Tests** assert on the plan's action list (not snapshot dirs), run
  deterministically (`platform: "linux"`, EOL-normalized), and cover a determinism
  + idempotency case. Update `--json`/SARIF goldens deliberately in the same PR as
  any serialized-shape change.
