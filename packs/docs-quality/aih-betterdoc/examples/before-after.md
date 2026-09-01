# BetterDoc Before/After Examples

These examples show the intended behavior. They are not product claims.

## Scope a Security Claim

Before:

```md
The platform is secure and fully audited.
```

After:

```md
The API rejects requests without the required audience claim. The provided source does not show a completed security audit.
```

Audit:

```md
- Scoped `secure` to the source-backed audience-check behavior.
- Removed `fully audited` because no audit evidence was provided.
```

## Preserve Generated Content

Before:

```md
<!-- generated:start -->
GET /v1/users/{id}
<!-- generated:end -->

This endpoint gives you a world-class user API.
```

After:

```md
<!-- generated:start -->
GET /v1/users/{id}
<!-- generated:end -->

This generated endpoint reference documents `GET /v1/users/{id}`. Regenerate this section after changing the OpenAPI source.
```

Audit:

```md
- Preserved generated markers and endpoint text.
- Replaced unsupported hype with source-of-truth guidance.
```

## Separate Changelog From Release Notes

Changelog entry:

```md
## 1.4.0 - 2026-07-03

### Added
- Added `verify-bundle --require-signature`.
```

Release note:

```md
Version 1.4.0 adds a verification path that can fail closed when a required bundle signature is missing or invalid.
```
