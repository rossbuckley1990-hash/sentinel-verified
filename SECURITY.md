# Security policy

SENTINEL 0.1 is local advisory software. Read the [threat model](docs/THREAT-MODEL.md) before executing a repository. Local execution and agent integrations can run code with your operating-system account's privileges.

## Report a vulnerability

Use the repository's [private vulnerability reporting form](https://github.com/rossbuckley1990-hash/sentinel-verified/security/advisories/new) when GitHub private reporting is enabled. If the form is unavailable, open a minimal public issue asking maintainers to enable a private reporting channel; do not post exploit details, credentials or private code in that issue.

Include the affected version or commit, platform, a minimal reproduction, expected and observed behaviour, and the trust boundary affected. Particularly valuable reports include false VERIFIED results, ignored verifier failures, path traversal, command injection, checkpoint/source mismatch and evidence corruption accepted as valid.

Do not test against other people's repositories or services without permission. Redact access tokens, personal paths, private source, prompts and logs before sharing a reproduction.

## Supported versions

The current 0.1 release line receives security fixes. This is an early release with a deliberately narrow scope. No response-time guarantee, bug bounty or hostile-code sandbox is implied.

## Handling reports

Maintainers should reproduce the issue, agree on its impact under the documented threat model, prepare a regression test and release a fix. A security advisory should state the affected versions, practical impact and mitigation without overstating local protection.
