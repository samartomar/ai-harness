export const supportedAcceptArguments = (root, decisionId, decisionDigest) => ['policy', 'supported', 'accept', '--root', root, '--decision', decisionId, '--decision-digest', decisionDigest, '--target', 'codex', '--json'];
export const supportedInspectArguments = root => ['policy', 'supported', 'inspect', '--root', root, '--json'];
