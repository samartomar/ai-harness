# Windows environment

Development happens on Windows (PowerShell / Git Bash); CI is a 3-OS matrix
(ubuntu / windows / macos). These are the facts that only bite on Windows and
that agents keep re-deriving. If something failed *only* on Windows, start here.

## Spawning external tools

- **`.cmd` shims can't be spawned by `execFile`.** `npm`, `npx`, `yarn`, `pnpm`,
  and `scoop` are `.cmd` shims on Windows — `execFile` (no shell) cannot resolve
  them and fails as "not found". Route them through the `WIN_CMD_SHIMS` seam in
  `src/tools/install.ts` so they get `cmd /c`. That list covers *only* those
  five. Any new non-`.exe` external spawn (a `uvx` wrapper, `semgrep`, etc.) must
  be routed explicitly, with a `platform: "windows"` test asserting argv starts
  `["cmd", "/c", …]`. Real `.exe` tools (`node`, `git`, `gh`, `docker`, `uvx`)
  spawn directly — do not widen the shim list for them.
- **Match the missing-command signature exactly.** Detect a missing tool by
  cmd's literal `is not recognized`, never a broad `cannot find` — that collides
  with npm's own `Cannot find module`.
- **Never wrap `setx` or `mklink` in `cmd /c`.** cmd re-parses `&`, `%`, `^` in
  paths — a command-injection surface (fixed in #133). Call `setx.exe` directly
  (it also silently truncates values over 1024 chars and still exits 0) and use
  `fs.symlink(target, link, "junction")` instead of `mklink`.
- **Never pass bare `bash` as argv[0]** — it exits 127 on a default
  Git-for-Windows install. Resolve the absolute `…\Git\bin\bash.exe` first
  (`resolveBash` in `src/ecc/index.ts`, fixed in #136).

## Shells and env

- **Hook-host shell matrix** (validated against a live host — do not re-derive):
  Claude Code runs hook commands via `sh` / Git Bash / PowerShell, **never**
  `cmd.exe`, has no `commandWindows` field, and its hook timeout is in seconds.
  The cross-shell fail-open tail is `; exit 0`; POSIX `[ -f … ]` and `2>/dev/null`
  break under PowerShell. Codex is the only `cmd.exe` hook host (`.codex/hooks.json`,
  `commandWindows`). Kiro deliberately emits the older `when`/`then` hook schema
  and its `Stop`/`PostToolUse` hooks are non-blocking — this is validated live,
  not a bug to "migrate".
- **Do not assume `cmd.exe` / Git Bash sessions see profile-set env vars** —
  env-block redirects currently land only in the PowerShell profile.
- **Preserve CRLF.** When rewriting a file that had `\r\n`, keep it; normalize
  `\r\n` → `\n` before running a regex on read (`src/internals/markers.ts` is the
  CRLF-aware precedent).

## Windows-only flakiness

- **Tests that spawn real `git` need an explicit `20000` ms vitest timeout** —
  slow Windows CI runners sit around ~5.6s against the 5s default. Apply the
  timeout with a `// slow Windows CI` comment; do not "fix" it by rerunning.
- `git worktree remove` can fail on a Windows-locked directory — de-register the
  worktree and ask for a manual delete rather than forcing it.
- `winget` needs `--accept-source-agreements --accept-package-agreements` and a
  timeout over 30s, or it hangs on the agreement prompt.
