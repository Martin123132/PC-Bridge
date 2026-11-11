const { contextBridge, ipcRenderer } = require('electron');
const workSessionCommands = ['workSessionSetting','workSessionResume'];
const localSchedulingCommands = ['setJobLimits'];
const commands = new Set(['state','jobDetail','saveConnection','connect','disconnect','enable','pause','demo','chooseProject','createProject','removeProject','chooseTest','chooseProjectTask','reapproveProjectTask','revokeProjectTask','reject','restore','openLink','openProject','copy','exportReport','chatView','chatReload','remoteConnect','remoteDisconnect','siriStart','siriStop','siriPairing','siriRotate','siriChooseEvidence','siriPerform','ensureClaudeClient','clientCreate','clientSetCeiling','clientSelectRemote','clientRemove','setAccessMode','approve','setDefaultProject','gitCheckpoint','gitRollback','vaultMonth','vaultDay','vaultSearch','vaultSnapshot']);
contextBridge.exposeInMainWorld('bridge', {
  call: (command, data) => { if (!commands.has(command)&&!workSessionCommands.includes(command)&&!localSchedulingCommands.includes(command)) return Promise.reject(new Error('Unsupported action.')); return ipcRenderer.invoke('pc-bridge', command, data); },
  onChange: callback => { const handler=()=>callback();ipcRenderer.on('pc-bridge-change',handler);return()=>ipcRenderer.removeListener('pc-bridge-change',handler); }
});
