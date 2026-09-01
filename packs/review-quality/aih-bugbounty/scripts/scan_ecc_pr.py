#!/usr/bin/env python3
"""Scan generated ECC/agent PR artifacts for BUGBOUNTY review risks."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python <3.11 fallback is unsupported here.
    tomllib = None  # type: ignore[assignment]


SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2, "info": 3}


@dataclass
class Finding:
    severity: str
    code: str
    path: str
    evidence: str
    recommendation: str


def git(repo: Path, args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result


def diff_names(repo: Path, base: str, head: str) -> list[str]:
    output = git(repo, ["diff", "--name-only", f"{base}...{head}"]).stdout
    return [line.strip() for line in output.splitlines() if line.strip()]


def show(repo: Path, ref: str, path: str) -> str | None:
    result = git(repo, ["show", f"{ref}:{path}"], check=False)
    if result.returncode != 0:
        return None
    return result.stdout


def add(findings: list[Finding], severity: str, code: str, path: str, evidence: str, rec: str) -> None:
    findings.append(Finding(severity, code, path, evidence.strip(), rec.strip()))


def is_sensitive_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    parts = [part for part in normalized.split("/") if part not in {"", "."}]
    if not parts or ".." in parts:
        return True
    if parts[0] == "secrets":
        return True
    return any(part.startswith(".env") for part in parts)


def is_codex_skill(path: str) -> bool:
    return (
        path.startswith(".agents/")
        or path.startswith(".codex/")
        or path.startswith("ai-coding/skills/")
    ) and path.endswith("/SKILL.md")


def has_frontmatter(text: str) -> bool:
    if not text.startswith("---\n"):
        return False
    end = text.find("\n---", 4)
    if end < 0:
        return False
    header = text[4:end]
    return bool(re.search(r"(?m)^name:\s*\S+", header)) and bool(
        re.search(r"(?m)^description:\s*\S+", header)
    )


def scan_skill_file(path: str, text: str, findings: list[Finding]) -> None:
    stripped = text.lstrip()
    if stripped.startswith("```"):
        add(
            findings,
            "high",
            "skill.whole-file-fence",
            path,
            "SKILL.md starts with a Markdown code fence, so the skill body/frontmatter will not parse as a normal skill.",
            "Remove the wrapper fence and put valid frontmatter at the top of the file.",
        )
    if is_codex_skill(path) and not has_frontmatter(text):
        add(
            findings,
            "high",
            "skill.frontmatter-missing",
            path,
            "Codex-facing skill file does not start with YAML frontmatter containing name and description.",
            "Add required skill frontmatter and keep trigger conditions in the description.",
        )
    if "ai-coding/RULE_ROUTER.md" not in text and ("workflow" in text.lower() or "coding conventions" in text.lower()):
        add(
            findings,
            "medium",
            "canon.router-missing",
            path,
            "Generated repo guidance describes workflows or conventions without routing through ai-coding/RULE_ROUTER.md.",
            "Make generated guidance subordinate to the repo canon and route readers to ai-coding/RULE_ROUTER.md first.",
        )


def load_json(text: str | None) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def canonical_mcp(repo: Path, base: str) -> dict[str, Any]:
    raw = show(repo, base, ".mcp.json")
    data = load_json(raw)
    if isinstance(data, dict) and isinstance(data.get("mcpServers"), dict):
        return data["mcpServers"]
    return {}


def package_version_state(arg: str) -> str | None:
    if not arg or arg.startswith("-"):
        return None
    package_like = arg.startswith("@") or "/" in arg or arg.startswith("mcp-")
    if not package_like:
        return None
    if arg.startswith("@"):
        after_scope = arg.split("/", 1)[1] if "/" in arg else arg
        version = after_scope.rsplit("@", 1)[1] if "@" in after_scope else ""
    else:
        version = arg.rsplit("@", 1)[1] if "@" in arg else ""
    if version == "":
        return "missing"
    if version == "latest":
        return "latest"
    return "pinned"


def scan_codex_config(repo: Path, base: str, head: str, path: str, findings: list[Finding]) -> None:
    if tomllib is None:
        add(findings, "medium", "scanner.toml-unavailable", path, "Python tomllib is unavailable.", "Use Python 3.11+ for TOML scanning.")
        return
    text = show(repo, head, path)
    if text is None:
        return
    try:
        parsed = tomllib.loads(text)
    except Exception as exc:  # noqa: BLE001 - scanner should report parser failure.
        add(findings, "high", "config.toml-invalid", path, str(exc), "Fix TOML syntax before accepting generated config.")
        return
    canonical = canonical_mcp(repo, base)
    servers = parsed.get("mcp_servers", {})
    if not isinstance(servers, dict):
        return
    if "approval_policy" in parsed or "sandbox_mode" in parsed or "web_search" in parsed:
        add(
            findings,
            "medium",
            "codex.runtime-policy-generated",
            path,
            "Generated repo config sets approval_policy, sandbox_mode, or web_search.",
            "Keep runtime policy user/tool controlled unless the repo canon explicitly owns it.",
        )
    for name, server in servers.items():
        if not isinstance(server, dict):
            continue
        if name not in canonical:
            severity = "high" if "url" in server else "medium"
            add(
                findings,
                severity,
                "mcp.added-server",
                path,
                f"Generated Codex config adds MCP server '{name}' that is absent from canonical .mcp.json.",
                "Require owner approval, egress classification, credential mode, and supply-chain pin before accepting.",
            )
        canon = canonical.get(name)
        if isinstance(canon, dict):
            if server.get("url") and server.get("url") != canon.get("url"):
                add(
                    findings,
                    "high",
                    "mcp.endpoint-drift",
                    path,
                    f"MCP server '{name}' URL is {server.get('url')!r}, canonical endpoint is {canon.get('url')!r}.",
                    "Keep generated config aligned with .mcp.json or document an explicit reviewed exception.",
                )
            if server.get("command") and server.get("command") != canon.get("command"):
                add(
                    findings,
                    "medium",
                    "mcp.command-drift",
                    path,
                    f"MCP server '{name}' command is {server.get('command')!r}, canonical command is {canon.get('command')!r}.",
                    "Keep command shape aligned with .mcp.json or document why the adapter differs.",
                )
        command = server.get("command")
        args = server.get("args", [])
        if command == "npx" and isinstance(args, list):
            for arg in args:
                if not isinstance(arg, str):
                    continue
                state = package_version_state(arg)
                if state in {"missing", "latest"}:
                    add(
                        findings,
                        "high",
                        "mcp.unpinned-package",
                        path,
                        f"MCP server '{name}' uses unpinned package argument {arg!r}.",
                        "Pin package versions or use the repo-approved hosted/local endpoint from .mcp.json.",
                    )


def scan_mcp_server_shape(
    canonical: dict[str, Any],
    path: str,
    name: str,
    server: dict[str, Any],
    findings: list[Finding],
) -> None:
    if name not in canonical:
        severity = "high" if "url" in server else "medium"
        add(
            findings,
            severity,
            "mcp.added-server",
            path,
            f"Generated MCP config adds server '{name}' that is absent from canonical .mcp.json.",
            "Require owner approval, egress classification, credential mode, and supply-chain pin before accepting.",
        )
    canon = canonical.get(name)
    if isinstance(canon, dict):
        if server.get("url") and server.get("url") != canon.get("url"):
            add(
                findings,
                "high",
                "mcp.endpoint-drift",
                path,
                f"MCP server '{name}' URL is {server.get('url')!r}, canonical endpoint is {canon.get('url')!r}.",
                "Keep generated config aligned with .mcp.json or document an explicit reviewed exception.",
            )
        if server.get("command") and server.get("command") != canon.get("command"):
            add(
                findings,
                "medium",
                "mcp.command-drift",
                path,
                f"MCP server '{name}' command is {server.get('command')!r}, canonical command is {canon.get('command')!r}.",
                "Keep command shape aligned with .mcp.json or document why the adapter differs.",
            )
    command = server.get("command")
    args = server.get("args", [])
    if command == "npx" and isinstance(args, list):
        for arg in args:
            if not isinstance(arg, str):
                continue
            state = package_version_state(arg)
            if state in {"missing", "latest"}:
                add(
                    findings,
                    "high",
                    "mcp.unpinned-package",
                    path,
                    f"MCP server '{name}' uses unpinned package argument {arg!r}.",
                    "Pin package versions or use the repo-approved hosted/local endpoint from .mcp.json.",
                )


def scan_mcp_json(repo: Path, base: str, head: str, path: str, findings: list[Finding]) -> None:
    text = show(repo, head, path)
    data = load_json(text)
    if not isinstance(data, dict):
        add(findings, "high", "mcp.config-invalid", path, "MCP config is not valid JSON.", "Fix MCP config JSON before accepting generated config.")
        return
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return
    canonical = canonical_mcp(repo, base)
    for name, server in servers.items():
        if isinstance(name, str) and isinstance(server, dict):
            scan_mcp_server_shape(canonical, path, name, server, findings)


def scan_codex_agent(repo: Path, head: str, path: str, findings: list[Finding]) -> None:
    if tomllib is None:
        add(findings, "medium", "scanner.toml-unavailable", path, "Python tomllib is unavailable.", "Use Python 3.11+ for TOML scanning.")
        return
    text = show(repo, head, path)
    if text is None:
        return
    try:
        parsed = tomllib.loads(text)
    except Exception as exc:  # noqa: BLE001 - scanner should report parser failure.
        add(findings, "high", "agent.toml-invalid", path, str(exc), "Fix TOML syntax before accepting generated agent config.")
        return
    role = Path(path).stem.lower()
    sandbox = parsed.get("sandbox_mode")
    justification = parsed.get("justification") or parsed.get("write_justification")
    reviewer_role = "reviewer" in role or "review" in role or "explorer" in role
    write_sandbox = isinstance(sandbox, str) and sandbox not in {"", "read-only", "readonly"}
    if reviewer_role and write_sandbox and not isinstance(justification, str):
        add(
            findings,
            "high",
            "agent.write-sandbox",
            path,
            f"Reviewer/explorer agent '{role}' sets sandbox_mode {sandbox!r} without a written justification.",
            "Keep reviewer/explorer agents read-only or add an explicit reviewed write-role justification.",
        )


def file_name_evidence(repo: Path, base: str) -> tuple[int, int]:
    output = git(repo, ["ls-tree", "-r", "--name-only", base, "src"], check=False).stdout
    names = [Path(line).name for line in output.splitlines() if line.endswith(".ts")]
    camel = sum(1 for name in names if re.fullmatch(r"[a-z][A-Za-z0-9]*\.ts", name))
    non_camel = len(names) - camel
    return camel, non_camel


def test_dir_count(repo: Path, base: str) -> int:
    output = git(repo, ["ls-tree", "-r", "--name-only", base, "tests"], check=False).stdout
    dirs = {line.split("/", 2)[1] for line in output.splitlines() if line.startswith("tests/") and "/" in line}
    return len(dirs)


def scan_claims(repo: Path, base: str, path: str, text: str, findings: list[Finding]) -> None:
    lower = text.lower()
    if "use camelcase" in lower and "file" in lower:
        camel, non_camel = file_name_evidence(repo, base)
        if non_camel > 0:
            add(
                findings,
                "medium",
                "claim.file-naming-overstated",
                path,
                f"Generated guidance says to use camelCase file names, but src contains {non_camel} non-camelCase TypeScript file names and {camel} camelCase names.",
                "Scope the claim to observed local patterns or route to the repo canon instead of making it a rule.",
            )
    if re.search(
        r"\b(only|just)\b.{0,120}\b(run|runs|cover|covers|use|uses)\b.{0,240}tests/workspace.{0,240}tests/report",
        lower,
        flags=re.DOTALL,
    ):
        count = test_dir_count(repo, base)
        if count > 2:
            add(
                findings,
                "medium",
                "claim.over-narrow-tests",
                path,
                f"Generated workflow names only tests/workspace and tests/report, but the repo has {count} top-level tests/* areas.",
                "Describe tests as mirrored by touched area and defer exact routing to ai-coding/RULE_ROUTER.md.",
            )
    if "src/program.ts" in text and "version" in lower:
        version_file = show(repo, base, "src/version.ts")
        if version_file is not None:
            add(
                findings,
                "medium",
                "claim.release-version-source",
                path,
                "Generated release workflow points to src/program.ts for version updates while src/version.ts exists as the version source.",
                "Verify release instructions against current release/version implementation before accepting.",
            )
    missing_verify_gate = re.search(
        r"\b(?:completion\s+(?:gate|check|verification|validation)|release\s+(?:gate|checklist|validation))\b",
        lower,
        flags=re.DOTALL,
    ) or re.search(
        r"\brelease\s+workflow\b.{0,120}\b(?:run|runs|pass|passes|before|must|should|gate)\b",
        lower,
        flags=re.DOTALL,
    )
    if "npm run verify" not in text and missing_verify_gate:
        add(
            findings,
            "low",
            "claim.verify-gate-missing",
            path,
            "Workflow guidance does not mention the repo completion gate npm run verify.",
            "Add the completion gate or route workflow guidance through the repo canon.",
        )


def scan_instincts(path: str, text: str, findings: list[Finding]) -> None:
    docs = [doc for doc in text.split("\n---\n") if doc.strip()]
    for doc in docs:
        confidence_match = re.search(r"(?m)^confidence:\s*([0-9.]+)", doc)
        confidence = float(confidence_match.group(1)) if confidence_match else 0.0
        weak = "18 commits analyzed" in doc or "Seen in commit" in doc or "Examples:" in doc
        if confidence >= 0.9 and weak:
            id_match = re.search(r"(?m)^id:\s*(.+)", doc)
            instinct_id = id_match.group(1).strip() if id_match else "(unknown)"
            add(
                findings,
                "medium",
                "instinct.weak-evidence-high-confidence",
                path,
                f"Instinct {instinct_id} has confidence {confidence} with shallow/generated evidence.",
                "Lower confidence, add stronger evidence, or keep the instinct advisory and subordinate to repo canon.",
            )


def scan_manifest(path: str, text: str, changed: list[str], findings: list[Finding]) -> None:
    data = load_json(text)
    if not isinstance(data, dict):
        add(findings, "high", "manifest.invalid-json", path, "Manifest is not valid JSON.", "Fix or remove malformed manifest.")
        return
    readiness = data.get("referenceSetReadiness")
    if isinstance(readiness, dict) and readiness.get("score") == 0:
        add(
            findings,
            "medium",
            "coverage.reference-set-missing",
            path,
            "Manifest reports referenceSetReadiness score 0 while the PR still proposes generated review assets.",
            "Treat this as degraded coverage; require independent review or reference fixtures before relying on generated guidance.",
        )
    managed = set(data.get("managedFiles", [])) if isinstance(data.get("managedFiles"), list) else set()
    unmanaged = [p for p in changed if p.startswith((".claude/", ".codex/", ".agents/")) and p not in managed and p != path]
    if unmanaged:
        add(
            findings,
            "low",
            "manifest.managed-files-gap",
            path,
            f"Generated manifest does not list changed generated files: {', '.join(unmanaged[:5])}.",
            "Keep manifest coverage aligned with the actual PR diff.",
        )


def scan(repo: Path, base: str, head: str) -> tuple[list[str], list[Finding]]:
    changed = diff_names(repo, base, head)
    findings: list[Finding] = []
    for path in changed:
        if is_sensitive_path(path):
            add(
                findings,
                "info",
                "sensitive.skipped",
                path,
                "Changed sensitive path was skipped without reading file contents.",
                "Review through the repo-approved secrets workflow instead of this generated-artifact scanner.",
            )
            continue
        text = show(repo, head, path)
        if text is None:
            continue
        if path.endswith("/SKILL.md"):
            scan_skill_file(path, text, findings)
        if path == ".codex/config.toml":
            scan_codex_config(repo, base, head, path, findings)
        if path == ".mcp.json":
            scan_mcp_json(repo, base, head, path, findings)
        if path.startswith(".codex/agents/") and path.endswith(".toml"):
            scan_codex_agent(repo, head, path, findings)
        if path.endswith(".md") or path.endswith(".yaml") or path.endswith(".yml"):
            scan_claims(repo, base, path, text, findings)
        if "homunculus/instincts" in path and path.endswith((".yaml", ".yml")):
            scan_instincts(path, text, findings)
        if path.endswith("ecc-tools.json"):
            scan_manifest(path, text, changed, findings)
        if path.endswith("AGENTS.md") and "ai-coding/RULE_ROUTER.md" not in text:
            add(
                findings,
                "medium",
                "canon.router-missing",
                path,
                "Agent guidance does not mention ai-coding/RULE_ROUTER.md.",
                "Route tool-local instructions through the repo canon.",
            )
    return changed, sorted(findings, key=lambda f: (SEVERITY_RANK.get(f.severity, 99), f.path, f.code))


def print_markdown(changed: list[str], findings: list[Finding], base: str, head: str) -> None:
    counts = Counter(f.severity for f in findings)
    print(f"# BUGBOUNTY PR scan ({base}...{head})")
    print()
    print(f"- Changed files: {len(changed)}")
    print(f"- Findings: {len(findings)}")
    for severity in ["high", "medium", "low", "info"]:
        if counts[severity]:
            print(f"- {severity}: {counts[severity]}")
    print()
    for index, finding in enumerate(findings, start=1):
        print(f"## {index}. [{finding.severity}] {finding.code}")
        print()
        print(f"- Path: `{finding.path}`")
        print(f"- Evidence: {finding.evidence}")
        print(f"- Recommendation: {finding.recommendation}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="repository root")
    parser.add_argument("--base", default="main", help="base git ref")
    parser.add_argument("--head", required=True, help="head git ref")
    parser.add_argument("--markdown", action="store_true", help="print markdown instead of JSON")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    changed, findings = scan(repo, args.base, args.head)
    if args.markdown:
        print_markdown(changed, findings, args.base, args.head)
    else:
        print(json.dumps({"changedFiles": changed, "findings": [asdict(f) for f in findings]}, indent=2))
    return 1 if any(f.severity == "high" for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
