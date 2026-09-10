export const supportedAcceptArguments = (root, decisionId, decisionDigest) => ['policy', 'supported', 'accept', '--root', root, '--decision', decisionId, '--decision-digest', decisionDigest, '--target', 'codex', '--json'];
export const supportedInspectArguments = root => ['policy', 'supported', 'inspect', '--root', root, '--json'];
const npmDecisionArguments = (decisionId, decisionDigest) => ['--decision', decisionId, '--decision-digest', decisionDigest, '--target', 'codex', '--json'];
export const npmObserveArguments = (root, decisionId, decisionDigest) => ['policy', 'observe', 'npm-package', root, ...npmDecisionArguments(decisionId, decisionDigest)];
export const npmLifecycleArguments = (root, decisionId, decisionDigest, apply = false) => ['policy', 'lifecycle', 'npm-package', root, ...npmDecisionArguments(decisionId, decisionDigest), ...(apply ? ['--apply'] : [])];
export const policyEvaluateArguments = root => ['policy', 'evaluate', root, '--cli', 'codex', '--json', '--no-log'];
export const workbenchGenerateArguments = htmlPath => ['policy', 'generate', '--apply', '--out', htmlPath, '--no-log'];
