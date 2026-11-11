# Siri via Apple Shortcuts — developer integration guide

**Source preview:** Connect Siri is integrated into the existing PC Bridge Windows application and has been tested on one PC with an iPhone Siri-triggered Shortcut. Published installer assets may lag behind this source update. This is not a general Siri AI/MCP tool connector.

## Prerequisites

- A Windows PC with this development build running.
- iPhone on the same trusted private Wi-Fi/LAN as the PC.
- Apple's Shortcuts app and Siri, on an iOS version that supports launching named shortcuts.
- The owner explicitly enables PC Bridge access and Siri's separate local connection.

No paid AI subscription, iPhone jailbreak, or custom iPhone app is required for this *limited Shortcut-triggered* workflow.

## Set up

1. On Windows, open PC Bridge and choose **Connect Siri**.
2. Click **Start Siri connection**. It binds a dedicated local port only on a private IPv4 Wi-Fi/Ethernet address (default port 48764). The server does not start automatically on installation.
3. Siri's client maximum authority starts at **Read only**. Status queries can run while PC Bridge global access is on. For the three fixed app-opening actions, you must explicitly approve the Siri **Full access ceiling** and have the PC Bridge global mode set to Full access. This does *not* expose arbitrary shell execution through the Siri endpoint.
4. To enable the accessibility build demonstration, choose **Choose evidence folder** and select the folder containing the recorded `delivery-receipt.json`, `runtime-tests-verified.exit` and `source-tests-rerun.exit`. This choice is made locally, not by the iPhone request.
5. Click **Show private pairing details**. Keep the credential private; it belongs only in your own Shortcut and the encrypted Windows pairing store.
6. On the iPhone create a Shortcut named **Control My PC**:
   - **Ask for Input**: Text, prompt "What should I do on the PC?"
   - **URL**: copy the action address from the PC Bridge pairing view.
   - **Get Contents of URL**: Method POST, Request Body JSON, one text field **request** populated by the *Ask for Input* variable, and HTTP header **x-siri-key** populated by the pairing key.
   - **Speak Text**: speak the text returned by *Get Contents of URL*. It is not a fixed preset response.
7. Invoke by name: "Hey Siri, Control My PC". When asked, try "check my PC", followed by "open Notepad" after enabling that permission.

## What this does

- **status**: returns live PC availability and RAM figures.
- **check_codex**: checks whether relevant Codex process names are running. A process being present does not prove a task is making progress.
- **codex_tasks**: reads the Windows account's local Codex task database, reporting recent turns recorded as in progress and a short task label. This is not a guarantee that computation is advancing.
- **accessibility_build**: checks the saved build receipts under the locally chosen evidence folder and confirms whether the output executable exists.
- **review_accessibility_build**: performs the build check and, if the results folder exists and the separate Siri Full permission is enabled, opens it with File Explorer.
- **open_notepad**, **open_calculator**, **open_explorer**: start specific Windows applications.
- **open_apple_music**: requests the installed Windows Apple Music application and checks for a stable visible window before reporting success.
- **open_google**, **search_google**: open Google or an encoded query in Microsoft Edge.
- The local bridge validates its normal access mode, the separate Siri ceiling, the request key, and the allowlist.
- PC Bridge's tamper-evident receipt chain records each request, denial, intent and outcome. The key and raw voice dictation are not included.
- Press **Pause access** in PC Bridge to stop Siri actions. Press **Stop Siri connection** to close its listener; choose **Revoke pairing** to invalidate the old phone credential.

## Network and security boundaries

The developer prototype uses **HTTP over the private local network**, not TLS. Treat this as a controlled home-network demonstration; plaintext network traffic and headers should not be trusted on a shared or untrusted Wi-Fi network. A public-facing release needs a secure pairing and transport experience, or prominent restrictions and independent security review. Do not forward port 48764 through your router.

The service binds only to a selected RFC1918 IPv4 interface, not to 0.0.0.0, and needs a separate strong random 256-bit secret. Credentials are stored with Electron Windows encrypted storage. The iPhone must be able to reach the PC's current LAN address; firewall or DHCP changes may prevent this, and laptop sleep stops responses.

This is **a Siri-triggered Shortcut adapter**, not a standalone agent with access to ChatGPT or Claude MCP tools. The `Use Model` Shortcut action and agent-directed multistep planning are separate experiments to validate.

## Development acceptance

- Source module tests, Siri client lifecycle/policy tests, renderer regression tests.
- Windows desktop smoke test, clean installer build and install/uninstall testing.
- Physical iPhone pairing, voice, real Windows launch, mode changes, key rotation and revocation.
- Wi-Fi, firewall, sleep, app restart and multiple client interaction tests.
- Full test suite, release verifier, secret scan and owner code review.

**Do not commit any real private pairing key, private IP tied to an installation, or personal Shortcuts export containing credentials.**
