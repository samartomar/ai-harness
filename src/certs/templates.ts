/**
 * Doc-action bodies for the `certs` capability — guidance the harness prints but
 * never runs. Homebrew and conda may be absent on a given workstation, so their
 * trust steps are emitted as exact, copy-pasteable commands rather than executed
 * (the boundary: local-only execs go through `exec`; everything advisory is a
 * `doc`). Commands are quoted verbatim from the blueprint's Package Manager
 * Configuration Matrix so the generated guidance stays faithful.
 */

import { lines } from "../internals/render.js";

/** Guidance when no CA in the OS trust store matched the requested pattern. */
export function noCertDoc(pattern: string, shellFlag: string): string {
  return lines(
    `No root CA matching "${pattern}" was found in the OS trust store.`,
    "",
    "This is expected on a workstation without an intercepting proxy (e.g. Zscaler,",
    "Netskope, Palo Alto). If your network does intercept TLS, the corporate CA may",
    "be filed under a different subject. Re-run with the issuer substring, e.g.:",
    "",
    `  aih certs ${shellFlag}`,
    "",
    "Find the subject of the intercepting CA with one of:",
    "  - Windows : Get-ChildItem Cert:\\CurrentUser\\Root | Select-Object Subject",
    "  - macOS   : security find-certificate -a -p /Library/Keychains/System.keychain | openssl x509 -noout -subject",
    "  - Linux   : ls /usr/local/share/ca-certificates /etc/pki/ca-trust/source/anchors",
  );
}

/** Homebrew trust step (macOS). The path differs on Intel vs Apple Silicon. */
export function homebrewDoc(pemPath: string): string {
  return lines(
    "Homebrew bundles its own CA store and does not read NODE_EXTRA_CA_CERTS.",
    "If `brew` is installed, copy the corporate CA into its openssl cert dir and",
    "rehash (REQUESTS_CA_BUNDLE is already exported by the profile block):",
    "",
    "  # Apple Silicon (default prefix /opt/homebrew):",
    `  cp ${pemPath} /opt/homebrew/etc/openssl@3/certs/ && /opt/homebrew/opt/openssl@3/bin/c_rehash`,
    "  # Intel (prefix /usr/local):",
    `  cp ${pemPath} /usr/local/etc/openssl@3/certs/ && /usr/local/opt/openssl@3/bin/c_rehash`,
    "",
    "Verify:  brew doctor",
  );
}
