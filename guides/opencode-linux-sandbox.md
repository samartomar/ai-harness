---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-09-13
truth_home: true
purpose: Configure and repeat a bounded OpenCode launch in a disposable Linux project.
---

# Repeatable OpenCode launches on Linux

Use this path to retain a disposable project's non-secret bindings across fresh
OpenCode processes. Each worktree has its own launch profile and client home.
Setup and launch use the ordinary AIH plan/apply boundary. The launcher uses
external Linux confinement; it does not enable a vendor-native OpenCode sandbox.

This path runs explicitly selected non-interactive OpenCode arguments. It does
not provide a general terminal launcher or a hosted-provider connection through
the network boundary. Review OpenCode's [CLI](https://opencode.ai/docs/cli/) and
[permissions](https://opencode.ai/docs/permissions/) for its native behavior.

## Prepare the consumer project

Use an ordinary disposable consumer repository, never an AIH source checkout.
Install and review the Linux OpenCode executable, `bubblewrap`, and the
`apply-seccomp` helper from the approved sandbox-runtime package separately.
AIH does not install these dependencies. Select their absolute executable paths
outside the consumer project, and retain the reviewed versions and hashes.

Select an external policy through the existing [policy delivery
contract](enterprise-developer-guide.md).
The policy path is a binding, not a grant of policy authority. Independent local
evaluators can use fictional policy fixtures; no particular organization's
repository, account or deployment system is required.

Bootstrap the project and apply its approved MCP configuration through the
existing [governed MCP workflow](../docs/governed-mcp.md). Review and preserve
client permissions, required guidance, and operator-owned configuration. A
governed MCP projection uses `aih policy project`; generic MCP generation cannot
take over a receipt-owned projection. Successful configuration alone does not
prove a native tool operation.

For a policy requiring enterprise posture, run these commands from the disposable
consumer root with its protected policy selected:

```bash
aih init . --cli opencode --policy "$POLICY" --apply
aih policy evaluate . --cli opencode --posture enterprise --policy "$POLICY"
aih policy project . --cli opencode --policy "$POLICY" --apply
```

The explicit posture on evaluation matters: this diagnostic does not infer its
posture from the policy floor. Resolve a rejected identity or approval through
the existing policy workflow before configuring the launcher.

## Save a launch profile

The following variables stand for the reviewed paths and a harmless native
request appropriate for the selected provider. Set them for this setup command;
subsequent launches read the saved profile.

```bash
aih sandbox --cli opencode --policy "$POLICY" \
  --bwrap-executable "$BWRAP" \
  --opencode-executable "$OPENCODE" \
  --seccomp-executable "$SECCOMP" \
  --binding AIH_SANDBOX_LABEL=disposable-demo \
  --binding OPENCODE_DISABLE_MODELS_FETCH=1 \
  --binding OPENCODE_DISABLE_AUTOUPDATE=1 \
  --binding OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
  --binding OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
  --hide-path "$HIDDEN_PATH" \
  --read-only-path "$READ_ONLY_PATH" \
  --client-arg run --client-arg "$REQUEST"
```

Inspect the plan, then repeat the same command with `--apply`. Use `--force` only
after reviewing an intentionally dirty setup worktree. Bindings are stored in
plaintext: supply only non-secret values, never credentials or process-injection
settings. Native provider authentication is separate from this setup.

The four explicit OpenCode settings disable network-dependent startup/download
behavior in this offline example. AIH accepts these named boolean settings,
`PATH`, and non-secret `AIH_*` values; it rejects arbitrary OpenCode config or
permission overrides. Provision required MCP/provider packages before launch.
Review the documented [OpenCode environment variables](https://opencode.ai/docs/cli/#environment-variables)
and preserve any plugins your project requires instead of disabling them blindly.

The local profile is `.aih/sandbox/opencode.json`; client state belongs to
`.aih/sandbox/opencode-home`. These are disposable, per-root runtime resources.
Retain the reviewed setup inputs if you remove `.aih/`. Setup does not install a
shell profile, alter account-wide client state, or distribute an administrator
policy. Repeat the same setup to check convergence.

## Launch, restart and change worktrees

From the configured root, preview and then explicitly launch:

```bash
aih sandbox --cli opencode --launch
aih sandbox --cli opencode --launch --apply
```

Each launch reloads the saved non-secret bindings and selected policy. The native
process starts from that root. After it exits, repeat the launch command from a
fresh terminal without exporting the setup variables again.
Each non-interactive launch has a 120-second execution limit. Review any dirty
worktree warning before deliberately adding `--force` to the launch command.

AIH rechecks governed projection, pins policy and executable bytes, and checks
the recorded identities of the selected hidden/read-only paths. An intentional
policy or runtime update requires reviewing and repeating setup. The profile is
local operator configuration; it is not an administrator-issued approval.

Keep external runtime, policy and protected-path locations under operator
control. File assertions are rechecked during apply; directory identities are
checked while planning the launch. This path does not protect against a hostile
host process replacing an external directory between planning and execution.

Run setup separately in worktree B, then launch from B. To return to A, run the
launch command from A. Do not copy A's local profile into B: a profile belongs to
its configured root. Setting up B must preserve A's profile, configuration,
client home, approvals and required guidance. Shared executable installations
remain operator-owned; setup does not stop daemons or delete another worktree's
resources.

## Check the boundary and results

The Linux boundary mounts the host `/` read-only, makes the selected consumer
root writable, provides private process/network state and temporary filesystem
mounts, and applies the selected hidden/read-only paths. The seccomp helper adds
its syscall restrictions before OpenCode starts. General host files remain
readable unless explicitly hidden. A read-only root mount is not general
credential-file isolation. Child MCP processes need the same observed boundary;
MCP discovery by itself proves neither execution nor confinement.

Inside the client, `.aih`, `opencode.json` and `.aih-config.json` are read-only
mounts. Only `.aih/sandbox/opencode-home` is writable within the AIH control
directory. Run operator setup and policy maintenance from outside the sandbox.

Before relying on a workflow, verify all of the following against fresh native
client processes:

- A harmless shell operation and an approved local MCP operation return the
  intended root, a randomized marker, the configured MCP identity and the real
  returned result.
- Repeat setup and launches in A and B preserve owned configuration and
  unrelated user state.
- Designated protected reads/writes and connections to live host TCP and Unix
  canaries are denied. Same-user controls work before and after; protected bytes
  remain unchanged.

Required missing resources, malformed profiles, wrong-root profiles, or changed
executable bytes require correction before launch. Inspect the reported failure
and reapply the reviewed setup only when its inputs intentionally changed. Do
not remove confinement or grant broader access merely to clear a check.

`aih ready` and routine doctor checks remain preflight checks. They do not run
this launch, start an MCP server, execute a project command, or turn an old
native report into a current READY result. Keep optional helper failures separate
from required failures. Runtime evidence must name the exact root, client,
configuration, policy, executable bytes and observation time.

The repository's explicit native acceptance driver uses fictional projects and
a deterministic local provider. It exercises actual client dispatch and returned
tool results, while real inference, hosted authentication, paid usage and
vendor-native sandbox enforcement remain separate acceptance work.

The opt-in source fixture is
`tests/sandbox/verify-opencode-repeatable-native.mjs`, with adjacent policy,
native plugin and MCP fixture scripts. It requires unprivileged Linux and
preprovisioned real runtimes. Run it explicitly; routine doctor and the unit suite
do not start it. Each attempt retains command receipts and native return values
in a new evidence directory and removes only its own disposable consumer tree.

For the fixture, provision the exact shipped Sequential Thinking package and
the plugin SDK matching the reviewed OpenCode version into separate disposable
package directories, using the real npm installer with `--ignore-scripts`.
Keep each package directory's `package.json`, `package-lock.json` and real
`node_modules` together. The runtime bin directory must contain working native
Node and npm's real `npx` launcher. Do not substitute an imitation MCP executable.
The driver copies these dependencies during initial consumer setup.

Generate the fictional policy with the source fixture's `--out` option (using
the repository's `tsx` loader, or its bundled equivalent), then run:

```bash
node tests/sandbox/verify-opencode-repeatable-native.mjs \
  --aih "$AIH_BIN" --policy "$APPROVED_POLICY" \
  --blocked-policy "$BLOCKED_POLICY" \
  --opencode "$OPENCODE" --bwrap "$BWRAP" --seccomp "$SECCOMP" \
  --mcp-script "$MCP_FIXTURE" --plugin-script "$PROVIDER_FIXTURE" \
  --managed-runtime "$MCP_PACKAGE_ROOT" \
  --plugin-runtime "$PLUGIN_PACKAGE_ROOT" \
  --runtime-path "$RUNTIME_BIN_DIR" --evidence-dir "$EVIDENCE_DIR"
```

All supplied paths are absolute; the evidence directory must already exist
outside `/tmp`, which the sandbox replaces. `AIH_BIN` must run the actual built
CLI. The test policy authoring fixture is fictional protected-file authority;
the current clean shipped control needs no waiver decision. The negative bundle
changes that identity so actual CLI evaluation must reject it.

## Resource cleanup

Close the owned client processes before removing their disposable consumer
worktrees. Remove only the worktrees and local runtime directories you created.
Keep shared executables, protected policy distribution, unrelated caches and
account-owned plugin/client state. Deleting a local launch profile requires
setup again; it does not revoke or replace the external policy or its approvals.
