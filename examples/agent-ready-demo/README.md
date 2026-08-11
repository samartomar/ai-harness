# AI-Harness Agent-Ready Demo

A deliberately small Node.js repository for demonstrating the AI-Harness first-run experience without using proprietary application code.

## What this demo proves

Start with an ordinary repository that has application code but no shared AI-engineering setup. Then use `aih` to inspect the workstation, preview the repository bootstrap, and apply the generated context and controls.

## 1. Copy the demo outside the AI-Harness repository

Do not run the demo in-place inside the AI-Harness source tree. Copy it to a clean folder first so the before/after change is easy to see.

```bash
mkdir -p /tmp/aih-demo
cp -R examples/agent-ready-demo/. /tmp/aih-demo/
cd /tmp/aih-demo
git init
```

On Windows PowerShell, copy the folder to a temporary working directory and run the remaining commands from there.

## 2. Look at the starting point

The repository intentionally contains only a tiny application, package metadata, and normal repo hygiene. There are no AI-Harness-managed context, policy, MCP, or guardrail artifacts yet.

```bash
find . -maxdepth 3 -type f | sort
```

## 3. Check the workstation

```bash
aih doctor
```

This is read-only. It helps answer whether the workstation is prepared for AI-assisted development.

## 4. Preview the repository bootstrap

```bash
aih init .
```

`aih init` is dry-run by default. Review the proposed changes before anything is written.

## 5. Apply the bootstrap

```bash
aih init . --apply
```

Now inspect the repository again:

```bash
find . -maxdepth 3 -type f | sort
```

The exact generated surfaces depend on the detected stack, posture, available tooling, and current AI-Harness release. The point of the demo is the workflow: inspect → preview → apply → review the repository-owned result.

## 6. Show the before/after story

For a short public demo, focus on four things:

1. The repository starts as ordinary application code.
2. `aih doctor` evaluates the developer environment.
3. `aih init .` shows a dry-run plan before writes.
4. `aih init . --apply` establishes repository-owned AI engineering context and controls that can be reviewed in Git.

## Suggested 60-second recording script

> This is a normal Node repository with no shared AI setup. First, `aih doctor` checks whether the workstation is ready. Next, `aih init .` previews what AI-Harness would add—without changing anything. When the plan looks right, `aih init . --apply` creates the repository-owned context and controls. The result is no longer one developer's ad-hoc AI configuration; it is something the team can inspect, version, review, and evolve with the code.

## Safety note

AI-Harness is open-source software provided on an AS-IS basis. Review planned and generated changes before adopting them in a real repository. See the project `DISCLAIMER.md` and security documentation for the authoritative boundaries.