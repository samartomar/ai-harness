# Public documentation policy

This repository is public. Contributors and maintainers must not commit private or
sensitive material here.

## Do not commit

- Customer names, tenant IDs, org IDs, or real support tickets.
- API keys, admin tokens, auth headers, private keys, certificates, or any secret.
- Real analytics exports, telemetry logs, prompt logs, usage logs, or `.jsonl` capture files.
- Unreleased go-to-market, pricing, competitor strategy, or private roadmap sequencing.
- Private planning notes, private repository references, or internal session handoff text.
- Customer-specific policy packs or deployment scripts.

## May be published

- Product architecture and sanitized implementation plans.
- Command reference and configuration.
- Security posture and release process.
- Public schemas and extension points.
- Fictional or demo data, clearly labeled as demo.

## Claims discipline

Public docs follow the project's documentation style: **claim-scoped, evidence-grounded, no
overstatement**. Do not describe the project as safe, secure, guaranteed, enterprise-ready,
enterprise-grade, production-ready, production-proven, certified, or compliant. Prefer scoped
mechanism claims (what a specific control does, under what condition) and label anything not
yet built as planned or proposed. See [DISCLAIMER.md](DISCLAIMER.md).

## Demo-data banner

Files containing demo data carry this banner:

```md
> Public demo data only. No customer data, no private org telemetry, no real user activity,
> and no production export.
```

## Scrub check

Before publishing docs, scan for accidental private content:

```bash
grep -RInE "tenant|org id|customer|admin key|api key|secret|token|GTM|pricing|competitor|support ticket|private repo|memory vault|session handoff" \
  docs README.md SECURITY.md SUPPORT.md .github package.json || true
```
