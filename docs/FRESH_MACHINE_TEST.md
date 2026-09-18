# Fresh-machine release test

Use this checklist on a Windows PC that has not been used to develop this copy of PC Bridge.

## Get the private release

While the repository is private, sign in to the company GitHub account and open the latest draft release for **Martin123132/PC-Bridge**.

Prefer the installer first:

- `PC-Bridge-Setup-0.5.16-Windows-x64.exe`

If installation is blocked or you specifically want to test the portable path, use:

- `PC-Bridge-0.5.16-Windows-x64.zip`

Check the SHA-256 values against `SHA256SUMS.txt`.

## First start

1. Start PC Bridge.
2. Confirm the window identifies itself as v0.5.16.
3. Do not copy any configuration files from Martin's PC.
4. Choose the permission mode you actually want for the test.

## ChatGPT path

Follow the repository's ChatGPT setup video or `docs/CHATGPT_SETUP.md` from scratch.

When connected, ask ChatGPT:

`Use PC Bridge. Call bridge_status only. Report the actual provider, transport, client maximum authority, global access mode and active workspace. Do not run or modify anything.`

If that succeeds, perform one harmless real-PC action that is permitted by the selected access mode.

## What to report back

Record:

- installer or ZIP used;
- whether Windows showed a security/SmartScreen warning;
- whether PC Bridge opened normally;
- whether ChatGPT connected without undocumented help;
- the actual `bridge_status` result;
- whether the harmless PC action happened;
- any confusing setup step;
- screenshots of any error.

Do not send runtime keys, full Claude MCP URLs or other connector secrets in screenshots/messages.
