# Connect PC Bridge to ChatGPT

This is the current ChatGPT setup path used by PC Bridge v0.5.16.

## Video

[Watch the full setup and first-test walkthrough](media/PC-Bridge-Setup-and-First-Test.mp4).

## 1. Prepare PC Bridge

Open PC Bridge and go to the ChatGPT connection/setup area.

You need:

- an OpenAI tunnel ID; and
- a restricted runtime API key authorised to use that tunnel.

Save the connection in PC Bridge and wait until the tunnel reports ready.

Do not share the runtime key or commit it to Git.

## 2. Enable ChatGPT Developer mode

In ChatGPT:

1. Open your profile.
2. Open **Settings**.
3. Open **Security and login**.
4. Enable **Developer mode**.

The exact visual path is shown in the video.

## 3. Create the PC Bridge app/plugin

Open **Plugins** → **Create app** → **New Plugin**.

For this PC Bridge connection choose **Tunnel**, not **Server URL**.

Select the OpenAI tunnel you configured in PC Bridge.

Do not paste a Claude-style persistent MCP URL into the ChatGPT Tunnel flow; they are separate connection methods.

## 4. Use PC Bridge in a normal chat

Enable the PC Bridge plugin/app in a normal ChatGPT chat and start with:

```text
Use PC Bridge. Call bridge_status only. Report the actual provider, transport,
client maximum authority, global access mode, active workspace and whether
project-task execution is available. Do not run or modify anything.
```

A successful response should report the real local PC Bridge state.

## 5. Harmless first action

After the status check, try a harmless action appropriate to your selected permission mode, such as reading a demo file or opening a simple local program.

Remember: Full access runs commands as your Windows user.
