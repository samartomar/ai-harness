# Evidence and Scope

Use this reference when claims involve product maturity, security, compliance, deployment, performance, enterprise readiness, customer proof, supply chain, data protection, or operational behavior.

## Claim Status Labels

Use source-backed status labels:

- Implemented: code, schema, config, or infrastructure definition exists.
- Tested: tests or CI prove behavior.
- Deployed: deployment evidence says it is live.
- Runtime-verifiable: an operator can verify with a command, API call, dashboard, artifact, or log.
- Documented: committed docs describe it, but implementation evidence was not checked.
- Planned: roadmap, TODO, issue, or design doc says it is future work.
- Prototype/POC: source labels it as prototype or proof of concept.
- Experimental: source labels it experimental or unstable.
- Deprecated: source says it should not be used for new work.
- User-provided: the user supplied the fact, but source evidence was not checked or is absent.
- Assumed: the edit depends on an inference.
- Unknown: source does not establish status.

Do not convert one status into another.

## Evidence Ladder

Prefer stronger evidence:

1. Passing tests, CI, reproducible commands, signed release artifacts, generated reports, or evidence bundles.
2. Source code, schemas, generated docs, config, or infrastructure definitions.
3. Runbooks, deployment manifests, logs, dashboards, audit records, or screenshots with date/context.
4. Committed docs and ADRs.
5. Issue/PR descriptions.
6. User-provided assertions.
7. Assumptions.

Label assumptions. Do not present them as facts.

## Direct vs Indirect Evidence

Direct evidence proves the claim itself.

```md
Test `x` asserts that untrusted input is rejected with status 403.
```

Indirect evidence suggests a behavior but does not prove the full claim.

```md
A test exists for the authorization module.
```

Do not turn indirect evidence into broad assurance.

## Scoped Security Claims

Use:

```md
[Control] prevents/detects/records [risk] in [scope] by [mechanism].
```

Examples:

```md
The API rejects requests without a valid audience claim.
```

```md
The workflow records approvals in the audit log before applying a protected change.
```

Avoid:

```md
The platform is secure.
```

```md
The system is fully compliant.
```

## Scoped Failure Behavior

If only a component fails closed, say that. If a logging path is best-effort, say that. If a behavior is unknown, do not infer it.

Better:

```md
The authorizer fails closed when required token claims are missing. Decision logging is best-effort, so missing log writes do not block the request.
```

## Data Protection / PII Claims

Risky without source:

```md
The system protects all PII.
```

Better when source-backed:

```md
The export command redacts email addresses from the generated report before writing it to disk.
```

For data protection claims, look for source evidence about:

- data collected,
- storage location,
- encryption,
- redaction/masking,
- retention/deletion,
- access control,
- logs and telemetry,
- cross-border or third-party sharing.

Do not infer privacy posture from the absence of code alone.

## Supply-Chain Claims

Risky without source:

```md
The release is SLSA-compliant.
```

Better when source-backed:

```md
The release process publishes an SBOM, checksum file, and provenance artifact. The source does not claim a formal SLSA level.
```

For supply-chain claims, identify the exact artifact:

- SBOM,
- checksum file,
- signature,
- provenance or attestation,
- release tag,
- package version,
- verification command,
- known limitations.

## Performance and Scalability Claims

Risky without source:

```md
The service scales to enterprise workloads.
```

Better when source-backed:

```md
The benchmark processed 10,000 requests with p95 latency under 200 ms on the documented test hardware.
```

Performance claims need:

- workload,
- environment,
- metric,
- measurement method,
- sample size/time window,
- result,
- limit or caveat.

Scalability claims need architecture or test evidence. Do not infer scale from cloud services, async queues, caching, or stateless design alone.

## Multi-Tenancy Claims

Risky without source:

```md
The platform is multi-tenant safe.
```

Better when source-backed:

```md
Tenant IDs are required in the request path, and the repository includes tests that reject cross-tenant reads.
```

Multi-tenancy claims need source evidence for isolation, identity, authorization, storage partitioning, audit boundaries, or failure behavior.

## Best-Effort Subsystems

Logging, metrics, traces, notifications, audit exports, telemetry, and background cleanup may be best-effort unless the source proves fail-closed behavior.

Use:

```md
The API writes an audit event after approval. The source does not show whether a failed audit write blocks the approval.
```

Do not say:

```md
Every approval is always audited.
```

unless the source proves the invariant.

## Product Identity

Preserve current product names, component names, command names, and surface names unless the source or user explicitly requests a rename.

Do not consolidate mixed naming into one brand without source authority.

## Maturity Examples

Safe:

```md
The feature is available in local development and covered by unit tests.
```

```md
The deployment guide describes production infrastructure, but the source does not show a production deployment record.
```

```md
The old CLI path is deprecated; use the new command in `tools/cli`.
```

Risky without source:

```md
Enterprise-ready.
```

```md
Production-proven.
```

```md
Fully secure.
```

```md
Not production-ready.
```

```md
SOC 2-ready.
```
