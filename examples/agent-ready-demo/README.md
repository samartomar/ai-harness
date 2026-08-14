# AI-Harness Agent-Ready Demo

> Public demo data only. No customer data, no private org telemetry, no real user activity,
> and no production export.

A deliberately small Node.js repository for demonstrating the AI-Harness first-run experience without using proprietary application code.

This is a **source-checkout-only** demo. It is not included in the npm package; clone this repository and build its CLI before copying the demo to a temporary directory.

## What this demo demonstrates

Start with an ordinary repository that has application code but no shared AI-engineering setup. Then use the CLI built from this checkout to inspect the workstation, preview the repository bootstrap, and apply the reviewed plan to the copied repository.

## 1. Copy the demo outside the AI-Harness repository

Do not run the demo in-place inside the AI-Harness source tree. Build the CLI, then copy the demo to a unique temporary folder so the before/after change is easy to see.

```bash
repo_root="$(pwd)"
npm run build
demo_root="$(mktemp -d "${TMPDIR:-/tmp}/aih-demo.XXXXXX")"
cp -R examples/agent-ready-demo/. "$demo_root/"
cd "$demo_root"
git init
git add .
git -c user.name="AIH Demo" -c user.email="aih-demo@example.invalid" commit -m "chore: seed demo"
```

```powershell
$repoRoot = (Get-Location).Path
npm run build
$demoRoot = Join-Path $env:TEMP "aih-demo-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $demoRoot | Out-Null
Copy-Item -Recurse -Force examples\agent-ready-demo $demoRoot
Set-Location (Join-Path $demoRoot "agent-ready-demo")
git init
git add .
git -c user.name="AIH Demo" -c user.email="aih-demo@example.invalid" commit -m "chore: seed demo"
```

## 2. Look at the starting point

The repository intentionally contains only a tiny application, package metadata, and normal repo hygiene. There are no AI-Harness-managed context, policy, MCP, or guardrail artifacts yet.

```bash
find . -maxdepth 3 -type f | sort
```

```powershell
Get-ChildItem -File -Recurse | Sort-Object FullName | Select-Object -ExpandProperty FullName
```

## 3. Check the workstation

```bash
node "$repo_root/dist/cli.js" doctor .
```

```powershell
node (Join-Path $repoRoot "dist/cli.js") doctor .
```

This is read-only. It helps answer whether the workstation is prepared for AI-assisted development.

## 4. Preview the repository bootstrap

```bash
node "$repo_root/dist/cli.js" init .
```

```powershell
node (Join-Path $repoRoot "dist/cli.js") init .
```

`aih init` is dry-run by default. Review the proposed changes before anything is written.

## 5. Apply the bootstrap

```bash
node "$repo_root/dist/cli.js" init . --apply
```

```powershell
node (Join-Path $repoRoot "dist/cli.js") init . --apply
```

Now inspect the repository again:

```bash
find . -maxdepth 3 -type f | sort
```

```powershell
Get-ChildItem -File -Recurse | Sort-Object FullName | Select-Object -ExpandProperty FullName
```

The exact generated surfaces depend on the detected stack, posture, available tooling, and current AI-Harness release. The point of the demo is the workflow: inspect → preview → apply → review the repository-owned result.

## 6. Show the before/after story

For a short public demo, focus on four things:

1. The repository starts as ordinary application code.
2. `aih doctor` evaluates the developer environment.
3. `aih init .` shows a dry-run plan before writes.
4. `aih init . --apply` writes the supported repository-owned setup selected by the plan; review the resulting diff before relying on it.

## Suggested 60-second recording script

> This is a normal Node repository with no shared AI setup. First, the built CLI's `doctor` command checks the workstation. Next, `init` previews the repository-owned setup without changing anything. After review, `init --apply` writes the selected setup to this temporary copy so the resulting diff can be inspected and versioned with the code.

## Safety note

AI-Harness is open-source software provided on an AS-IS basis. Review planned and generated changes before adopting them in a real repository. See the project `DISCLAIMER.md` and security documentation for the authoritative boundaries.
