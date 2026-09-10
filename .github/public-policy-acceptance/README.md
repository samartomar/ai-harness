# Actual Core 0.6.1 public policy acceptance

Dispatch the protected main workflow only after genuine public Core 0.6.1 and Catalog sequence 4 publication. This executes all three reviewed npm832, fixed managed usage and supported npm848 journeys on a fresh hosted Windows administrator VM. It is preparation until a real run and independent raw evidence verification succeed.

Public inputs: qualification_run, qualification_attempt, qualification_sha256 (sha256-prefixed raw JSON digest), catalog_run. Catalog source is fixed to 98d95263aa0901504c9d480628f6c06c4a1fe453; original candidate and sequence0–3 hashes remain pinned. Native gh verifies all provenance; installed verify-release requires three passes, zero failures and zero skips. All original WeakMap, parser, registry/tar/install, browser, nine conditional gaps, lifecycle and final checks remain required.

Temporary secret AIH_CORE061_SCAN_INPUTS is base64(gzip(UTF8 JSON)) with exact schema:
{"format":"aih-core061-private-scans/v1","files":{"scan-evidence-1.1.0.json":"original UTF8 text","scan-command-1.1.0.json":"original UTF8 text","scan-evidence-1.1.1.json":"original UTF8 text","scan-command-1.1.1.json":"original UTF8 text"}}
All four hashes/sizes validate before any decoded file write. Maximum encoded size48KiB, decompressed200000bytes. Do not sanitize or substitute originals.

AIH_CORE061_EVIDENCE_KEY is canonical base64 of32 cryptographically random bytes. Keep it privately for downloaded artifact decryption; retire both temporary secrets after independent verification. Neither secret reaches driver/package/browser children. This is never a Catalog signing key. Git identity truthfully uses github-actions[bot]; dispatch actor is separately retained.

All raw native output, browser downloads/screenshots, policy/control/results, scans, public artifacts and final supported custody are retained encrypted. Only raw-evidence.aes256gcm, ciphertext.sha256 and allowlisted fixed summary.json are uploaded. AES256GCM wire bytes: UTF8 AAD aih-core061-private-evidence/v1, NUL,12-byte nonce,16-byte tag,ciphertext. Plaintext is gzip JSON aih-core061-raw-files/v1 with relative paths,SHA256,base64 bytes. private-transport.mjs decrypt authenticates before yielding plaintext. Never expose decrypted evidence publicly; validate archive paths before extraction.

Child timeout45minutes leaves sealing time within60minute job. VM loss or forced termination cannot guarantee evidence retention and remains incomplete acceptance. No signing, publication, fixture authority, injected verifier, or ProgramData reset exists. All three final checks, zero child exit, completion marker and encrypted retention precede public PASS.

Focused checks from repository root:
node --import tsx .github/public-policy-acceptance/check-preparation.mjs
npx vitest run tests/release/hosted-policy-acceptance.test.ts
