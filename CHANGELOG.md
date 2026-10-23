# Changelog

## Unreleased

- Reduce desktop memory use by sending job summaries during refresh and loading complete receipts only when opened. Saved history and approval controls are preserved.
- Keep unchanged pages in place, reuse timestamp formatting, serialize refresh bursts, and release closed receipt content. Delayed receipt replies cannot replace a newer receipt or reopen a closed one.
- Add synthetic regression tests for large history, rendering, receipt races, refresh recovery and the preload command boundary.

## v0.5.16 — public preview candidate

### Included

- Windows desktop PC Bridge application.
- ChatGPT connection through the official OpenAI tunnel client.
- Persistent Claude remote MCP endpoint.
- Per-client authority ceilings plus global local access controls.
- File, project-task, command, Git and Vault tooling.
- Persistent Claude guest-tunnel identity with idle/TTL reconnection.
- Full ChatGPT setup and first-test tutorial video.
- Windows x64 installer and portable ZIP packaging.
- Release verifier for common secrets/local state and the bundled OpenAI tunnel-client hash.
- GitHub Actions CI.
- Dual source-available licensing for Two Hands Network Ltd code.

### Validation

- source regression tests pass;
- clean source Electron smoke passes;
- packaged Windows executable smoke passes;
- extracted release ZIP smoke passes;
- OpenAI tunnel-client SHA-256 is verified during release checks.

### Known release note

The current Windows preview is not code-signed. Windows SmartScreen may show an unrecognised publisher warning on a fresh PC. This does not change the checksum verification provided with each release.
