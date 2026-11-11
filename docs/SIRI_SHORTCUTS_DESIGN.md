# Siri / Apple Shortcuts integration — development candidate

**Status:** experimental source preview, integrated into the existing PC Bridge Windows application. The burgundy virtual phone is a Windows UI, not an iOS emulator. A Siri-triggered iPhone Shortcut has been tested with the integrated endpoint; wider device coverage remains to be verified.

## What was actually demonstrated

On one Windows PC and iPhone using the same private Wi-Fi network, an Apple Shortcut made an authenticated HTTP request to a temporary allowlisted Windows service. The service returned live RAM information, and a subsequent request launched Notepad. The iPhone displayed/spoke the returned message. No jailbreak or third-party iOS app was required.

This proves **Siri-triggered Shortcuts → network request → allowlisted Windows action → response**. It does not prove that Siri AI can discover PC Bridge MCP tools, plan arbitrary multi-step work, or autonomously control Windows.

## Target UX

1. Windows app offers **Connect Siri**, disabled by default.
2. Local owner enables a *separate Siri client* with a conservative permission ceiling.
3. App pairs an iPhone with an owner-approved local key (or one-time invitation); key never appears in public URLs, Git, diagnostic exports or screenshots.
4. One guided Shortcut asks what to do, sends a **named action** and speaks the result.
5. The user sees the Siri client in PC Bridge's Activity log, can revoke it immediately, and can Pause access to stop all actions.
6. Only commands actually present in the allowlist can run. Arbitrary shell commands require a separately designed approval path and are not part of this pilot.

## Current development implementation

`src/siri-shortcuts.mjs` is a deliberately inert transport module. Importing it does not start a listener. The owner application must explicitly provide a 32-byte key, bind address, handlers, a local authorisation callback and a receipt callback.

Pilot request: `POST /v1/action` with `Content-Type: application/json` and `x-siri-key` header; body `{"request":"open notepad"}` or `{"action":"open_notepad"}`.

Response: plain text for Apple's `Speak Text` action. Error responses have non-2xx status. The parser rejects unknown, compound and oversized instructions. The listener refuses browser-origin requests, requires the key for each request and applies a per-instance cooldown.

The supported action identifiers include `status`, `check_codex`, `codex_tasks`, `accessibility_build`, `review_accessibility_build`, `open_notepad`, `open_calculator`, `open_explorer`, `open_apple_music`, `open_google`, and `search_google`. The integrated `src/siri-connection.mjs` binds an opt-in listener under BridgeCore with its own Siri client identity. A physical iPhone Shortcut test against that integrated endpoint has succeeded.

## Integration required before GitHub release

- [x] Integrate the source implementation with `BridgeCore` access checks and `ClientRegistry` Siri identity. Global Pause blocks Siri requests.
- [x] Add a separate Siri client ceiling and a fixed allowlist in the PC Bridge UI; no implicit inheritance from Claude or ChatGPT. Per-action configurable grants remain future work.
- [ ] Tamper-evident Siri receipts are written to BridgeCore; finish the Activity-page presentation of those receipts.
- [x] Keep device-pairing credentials in Windows encrypted storage; rotate and revoke them.
- [ ] Use authenticated HTTPS, or a locally confined/private network deployment whose limitations are documented and explicitly accepted. Never assume plaintext LAN traffic is encrypted.
- [ ] Determine iPhone permissions, background limitations, multiple-device Wi-Fi behavior, firewall onboarding and Windows sleep behavior through physical device tests.
- [ ] Add a guided Shortcut generator/import route requiring minimal manual input; avoid pasting long secret-bearing instructions into a chat.
- [ ] Test Windows 10/11, different networks, firewall states, UAC, app launch behavior, expired/revoked tokens and duplicate/rapid requests.
- [ ] Verify desktop packaging, clean installation and removal; run `npm test` and `npm run verify:release`, plus an independent security review.
- [ ] Publish a truthful demo contrasting voice-triggered fixed commands versus model-directed multi-step tasks.

## Research questions for more advanced Siri operation

Apple Shortcuts can provide user-supplied input. Additional AI-driven intent selection may be possible through system-supported model actions, but availability and actual permissions must be verified on the target iOS version. A model result is always treated as untrusted until mapped to a permitted action; it must never be converted directly into PowerShell.

## Claims discipline

Do not describe this as an official Apple integration or as Siri having general access to PC Bridge's MCP tools. The prototype is **Windows control through a Siri-triggered Apple Shortcut**, with a narrow action allowlist.

## Verified demo actions in the integrated source

The integrated source has eight exact, allowlisted voice actions. Three evidence actions use read-only local Codex SQLite records and a build-evidence folder selected through the PC Bridge desktop UI. No user's absolute drive path is included in the repo. Codex and build status require the Siri read permission; opening the fixed results folder requires both the global and separate Siri client Full Access settings. Siri cannot supply arbitrary paths or shell commands. Physical testing demonstrated an iPhone Shortcut calling the integrated endpoint and launching Apple Music on Windows. Cross-device and clean-install coverage remain outstanding.
