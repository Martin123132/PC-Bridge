# Connect PC Bridge to Claude

PC Bridge v0.5.16 supports Claude through a persistent remote MCP endpoint.

## 1. Prepare the endpoint

Open **Connect Claude** in PC Bridge and choose **Prepare Claude endpoint**.

PC Bridge creates a local Claude client identity and a persistent HTTPS route for this installation.

Wait for **Endpoint ready**.

## 2. Copy the full MCP URL

Copy the full MCP URL shown by PC Bridge.

Treat the full URL like a password. The final path contains a capability secret.

Do not publish it, place it in screenshots, or commit it to Git.

## 3. Add it to Claude

In Claude connectors:

1. choose **Add custom connector**;
2. name it **PC Bridge**;
3. paste the full MCP server URL;
4. continue and enable the connector.

## 4. Test it

In a normal Claude chat, ask:

```text
Use PC Bridge. Call bridge_status only. Report the actual provider, transport,
client maximum authority, global access mode, active workspace and whether
project-task execution is available. Do not run or modify anything.
```

The working connection reports `anthropic-claude` over `remote-mcp`.

## Persistence

The installation stores its tunnel identity locally using Windows encrypted storage and restores the same connector route after PC Bridge restarts.

The tunnel wrapper also reconnects the same saved identity after service idle/TTL closures.

Use **Revoke endpoint** only when you actually want to delete the saved Claude route and create a different one later.
