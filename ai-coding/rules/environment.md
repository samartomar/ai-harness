# Environment

> Load when: touching platform-specific behavior — shells, paths, spawning tools, line endings.

This repo is developed on one OS and tested on another (currently a Windows dev
box against a 3-OS CI matrix). Treat the platform as a variable, not a constant.

- **Don't assume the host.** Shell, path separator, line endings, and how an
  external tool launches all differ by OS. A green run on one OS does not clear
  another — verify platform-specific behavior on the actual target.
- **Spawn external tools through the runner seam** (`src/tools/install.ts`), not a
  bare `execFile` — some tools are shell shims that won't launch directly. Add a
  new external spawn there with a per-OS test, not ad hoc.
- **Line endings:** normalize on read, preserve the file's existing style on
  write — never let a rewrite flip a repo's EOL.
- **Subprocess tests need generous timeouts** — CI runner speed varies widely; a
  test that spawns real `git`/tools should not ride the default.

## Windows, the current dev box

Environment-contingent — skip when developing elsewhere:

- `npm`/`npx`/`yarn`/`pnpm` are `.cmd` shims a direct `execFile` can't find; route
  them through the shim seam. Detect a missing tool by cmd's literal
  `is not recognized`.
- Never wrap `setx`/`mklink` in `cmd /c` (metacharacter re-parsing) — call
  `setx.exe` directly and use a filesystem junction.
- Resolve an absolute `bash` path; bare `bash` exits 127 on default
  Git-for-Windows.
- Hook host shells differ by tool (Claude: sh/PowerShell, never cmd; Codex:
  cmd.exe) — keep hook commands cross-shell and fail-open.
