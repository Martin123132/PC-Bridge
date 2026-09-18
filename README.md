# PC Bridge

**Connect AI conversations to Windows workspaces you control.**

PC Bridge is a Windows desktop bridge that lets supported AI clients use locally authorised tools on your own PC. The AI stays in the chat you already use; PC Bridge provides the controlled connection to files, project tasks, commands and local state.

> Early public preview — v0.5.16

## Download

Windows x64 builds are published on the [GitHub Releases page](https://github.com/Martin123132/PC-Bridge/releases).

For most users, download:

- `PC-Bridge-Setup-0.5.16-Windows-x64.exe`

A portable ZIP is also provided:

- `PC-Bridge-0.5.16-Windows-x64.zip`

Verify downloads against `SHA256SUMS.txt` on the release.

**Current preview builds are not yet code-signed**, so Windows SmartScreen may warn when you first run them.

## See it working

[Watch the full ChatGPT setup and first-test video](docs/media/PC-Bridge-Setup-and-First-Test.mp4)

The video walks from opening PC Bridge, through the real ChatGPT setup, to a harmless action on the PC.

## What it currently supports

- ChatGPT through the official OpenAI tunnel client.
- Claude through a persistent remote MCP endpoint.
- Per-client authority ceilings.
- Global access modes: Read only, Files only, Project Tasks, Read + approve changes, and Full access.
- Protected file reads/writes.
- Locally approved project tasks and tests.
- Short commands and managed long-running processes.
- Git status/diff helpers.
- Local Vault activity history and source snapshots.
- A persistent ChatGPT web view inside the desktop app.

PC Bridge runs tools as the signed-in Windows user. **It is not an operating-system sandbox.**

## Quick start

### ChatGPT

Follow [docs/CHATGPT_SETUP.md](docs/CHATGPT_SETUP.md), or use the video above.

At a high level:

1. Open PC Bridge and configure the OpenAI tunnel ID + restricted runtime key.
2. Enable Developer mode in ChatGPT.
3. Create the ChatGPT app/plugin using **Tunnel** rather than **Server URL**.
4. Select your tunnel.
5. Add PC Bridge to a normal chat and call `bridge_status`.

### Claude

Follow [docs/CLAUDE_SETUP.md](docs/CLAUDE_SETUP.md).

PC Bridge creates a persistent HTTPS MCP endpoint for the local installation. Treat the full connector URL like a password: its final path contains a capability secret.

## Run from source

Requirements:

- Windows 10/11
- Node.js
- Git

```powershell
git clone https://github.com/Martin123132/PC-Bridge.git
cd PC-Bridge
npm ci
npm start
```

The repository includes the official OpenAI Windows tunnel client under `vendor/`, with its original licence and notice files.

## Test

```powershell
npm test
npm run verify:release
```

The release verifier checks the expected tunnel-client hash and rejects common credential/state patterns before publication.

## Security model

PC Bridge has two permission layers:

1. a global local access mode; and
2. a per-client maximum authority.

The stricter setting wins.

Use the lowest authority that fits the job. Full access can run arbitrary PowerShell, cmd and Node commands as your Windows user.

See [SECURITY.md](SECURITY.md).

## Privacy

PC Bridge keeps its local policy and activity state on the PC. Do not commit local state files, runtime keys, tunnel IDs or persistent connector URLs.

The Claude connection currently uses the `@maxoperf/tunnel` guest tunnel service to provide a persistent public HTTPS route to the locally authorised MCP endpoint.

## Licence

PC Bridge original code is **source-available under a dual licence**:

- PolyForm Noncommercial 1.0.0; **or**
- PolyForm Small Business 1.0.0,

at the user's option.

That means individuals, noncommercial users and qualifying small businesses can use, modify and redistribute PC Bridge within the applicable licence terms. Uses outside both grants require a separate commercial licence from Two Hands Network Ltd.

This is intentionally **not** presented as OSI-approved open-source software.

See [LICENSE](LICENSE), [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) and [TRADEMARKS.md](TRADEMARKS.md).

Third-party software retains its own licences. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `vendor/`.

## Company

PC Bridge is developed by **Two Hands Network Ltd**.
