# Security

PC Bridge can expose locally authorised PC capabilities to connected AI clients. Treat it like remote-access software.

## Report a vulnerability

Please report security issues privately to the repository owner before opening a public issue.

## Secrets and connector URLs

Never publish:

- OpenAI runtime API keys;
- OpenAI tunnel IDs tied to a real deployment;
- PC Bridge encrypted state files;
- persistent Claude MCP URLs, because the final path contains a capability secret;
- local diagnostic exports containing private paths.

The repository includes a release verifier that checks for several common accidental secret patterns before publishing.

## Local authority

PC Bridge enforces both a global access mode and a per-client authority ceiling. The stricter boundary wins. Use the lowest authority that fits the task.

Full access can execute commands as the signed-in Windows user. PC Bridge is not an operating-system sandbox.
