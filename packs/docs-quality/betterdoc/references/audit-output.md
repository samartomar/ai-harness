# Audit Output Patterns

Use concise audits unless the user asks for depth.

## Meaning Audit

```md
### Meaning audit

**What got clearer**
- Replaced vague setup with the direct product/task claim.
- Moved verification steps closer to the quickstart.

**Claims preserved or scoped**
- Preserved the source-backed authentication claim, but scoped it to the runtime API.
- Kept the maturity label as `beta` because the source labels it beta.

**Unsupported claims removed or flagged**
- Removed `enterprise-grade` because the source did not show certification, deployment, or customer proof.

**Tradeoffs / assumptions**
- Assumed the README audience is a first-time developer because the section starts with installation.
```

## Review Verdict

```md
### Verdict

Usable with changes. The doc is clear, but two claims are broader than the source supports.

### Material risks

- The security claim says the platform fails closed, but the source only proves fail-closed auth.
- The quickstart omits the expected output, so users cannot verify success.

### Suggested edits

- Scope the fail-closed claim to auth.
- Add expected output after the command block.

### Open questions

- Is the feature deployed to production or only available in staging?
```

## Diff Response

When the user asks for a diff, return a unified diff if possible. Follow it with a short audit.
