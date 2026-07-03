# Run Ledger v2 SIEM Recipe

> Status: shipped local diagnostics schema. The ledger is not committed; package
> it with `aih evidence build` for tamper-evident sharing.

Each initialized repo appends runs to `.aih/runs/YYYY-MM.jsonl`. Version 2 entries
include host and repo identifiers as hashes so teams can correlate activity
without logging raw hostnames or remote URLs.

## Field Map

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Ledger schema version, currently `2`. |
| `runId` | Per-run identifier. |
| `startedAt` | UTC start timestamp. |
| `finishedAt` | UTC finish timestamp. |
| `durationMs` | Wall-clock duration in milliseconds. |
| `capability` | Command capability, for example `trust`, `contract`, or `verify-release`. |
| `argv` | Redacted command argv. |
| `status` | `success`, `failed`, `partial`, or `error`. |
| `exitCode` | Process-style exit code when known. |
| `mode` | Flags such as apply, verify, json, or sarif. |
| `platform` | Node platform. |
| `node` | Node.js runtime version. |
| `host.platform` | Host platform captured with the run. |
| `host.hostnameHash` | SHA-256-derived hostname hash, prefixed with `host_`. |
| `repo.remoteHash` | SHA-256-derived first git remote hash, prefixed with `repo_`; `unknown` when absent. |
| `writes` | Count of planned/applied write actions. |
| `docs`, `execs`, `digests`, `backups` | Counts of planned document, process, digest, and backup actions. |
| `verification` | Optional verification verdict counts, for example `verification.fail`. |
| `support` | Optional support routing counts: `support.findings` and `support.templates`. |

## Splunk

```spl
index=aih sourcetype=aih:runledger schemaVersion=2
| stats count by repo.remoteHash, host.hostnameHash, capability, status
| sort - count
```

Find failed or partial enterprise runs:

```spl
index=aih sourcetype=aih:runledger schemaVersion=2 status IN ("failed", "partial", "error")
| table startedAt repo.remoteHash host.hostnameHash capability status exitCode argv
```

## Microsoft Sentinel / KQL

```kusto
AihRunLedger_CL
| where schemaVersion_d == 2
| summarize runs=count() by repo_remoteHash_s, host_hostnameHash_s, capability_s, status_s
| order by runs desc
```

Find commands that produced support findings:

```kusto
AihRunLedger_CL
| where schemaVersion_d == 2
| where support_findings_d > 0
| project TimeGenerated, repo_remoteHash_s, capability_s, status_s, support_findings_d, argv_s
```

Find failed verification probes:

```kusto
AihRunLedger_CL
| where schemaVersion_d == 2
| where verification_fail_d > 0
| project TimeGenerated, repo_remoteHash_s, host_hostnameHash_s, capability_s, verification_fail_d, argv_s
```

## Import Guidance

- Ingest JSONL as one event per line.
- Keep raw ledgers in a restricted evidence bucket; analysts usually need only
  parsed fields and the evidence bundle checksum.
- Do not join `host.hostnameHash` back to raw hostnames in broad dashboards.
- If a command is run with `--no-log` or `AIH_LOG=0`, absence of a row is
  expected and should not be treated as tampering by itself.
