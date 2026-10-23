// The activity list needs metadata, not a second copy of every saved file and
// command output. Full receipts remain in BridgeCore and are fetched on demand
// through the same owner-only IPC boundary as the rest of the desktop UI.
export function summarizeUiJob(job) {
  const { content, before, result, command, stderr_tail, ...summary } = job;
  return summary;
}
