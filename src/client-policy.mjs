const MODE_CAPABILITIES={
  read_only:new Set(['read']),
  files_only:new Set(['read','write']),
  project_tasks:new Set(['read','write','pinned_exec','control']),
  full:new Set(['read','write','pinned_exec','control','arbitrary_exec'])
};

export const CLIENT_ACCESS_MODES=Object.freeze(Object.keys(MODE_CAPABILITIES));

const LABELS={
  read_only:'Read only',
  files_only:'Files only',
  project_tasks:'Project Tasks',
  full:'Full access'
};

const CAPABILITY_LABELS={
  read:'read shared PC Bridge data',
  write:'write protected shared files',
  pinned_exec:'run locally pinned tests/project tasks',
  control:'cancel bridge jobs',
  arbitrary_exec:'run arbitrary commands or managed processes'
};

const clean=(value,fallback,max)=>String(value||fallback).replace(/[^A-Za-z0-9._:-]/g,'-').slice(0,max)||fallback;

export function makeClientPolicy({id,provider,transport,maxAccessMode}={}){
  const remote=transport==='remote-mcp';
  const mode=maxAccessMode??(remote?'read_only':'full');
  if(!Object.hasOwn(MODE_CAPABILITIES,mode))throw Error('Invalid client access ceiling.');
  return Object.freeze({
    id:clean(id,remote?'standard-chat':'openai-tunnel',80),
    provider:clean(provider,remote?'remote':'openai',40),
    transport:remote?'remote-mcp':'openai-tunnel',
    max_access_mode:mode
  });
}

export function clientAllows(policy,capability){
  const allowed=MODE_CAPABILITIES[policy?.max_access_mode];
  return Boolean(allowed&&allowed.has(capability));
}

export function assertClientCapability(policy,capability){
  if(clientAllows(policy,capability))return;
  const mode=LABELS[policy?.max_access_mode]||'Unknown';
  const action=CAPABILITY_LABELS[capability]||'perform this action';
  throw Error(`PC Bridge client policy limits ${policy?.provider||'this provider'}/${policy?.id||'this client'} to ${mode}. It may not ${action}. Change that client's ceiling locally in PC Bridge.`);
}

export function publicClientPolicy(policy){
  return {client_id:policy.id,provider:policy.provider,transport:policy.transport,max_access_mode:policy.max_access_mode,max_access_label:LABELS[policy.max_access_mode]};
}

export function statusForClient(status,policy){
  const writeGlobally=status.access_mode!=='read_only';
  const pinnedGlobally=['full','approve_changes','project_tasks'].includes(status.access_mode);
  const arbitraryGlobally=['full','approve_changes'].includes(status.access_mode);
  return {
    ...status,
    protected_file_write_available:writeGlobally&&clientAllows(policy,'write'),
    project_task_execution_available:Boolean(status.project_task_execution_available&&pinnedGlobally&&clientAllows(policy,'pinned_exec')),
    arbitrary_shell_available:Boolean(status.arbitrary_shell_available&&arbitraryGlobally&&clientAllows(policy,'arbitrary_exec')),
    client_policy:publicClientPolicy(policy),
    client_policy_rule:'The global PC Bridge access mode and this client ceiling both apply. The stricter boundary wins.'
  };
}

export function capabilityForTool(name){
  if(['bridge_write_file','bridge_propose_write'].includes(name))return 'write';
  if(['bridge_request_test','bridge_run_project_task'].includes(name))return 'pinned_exec';
  if(['bridge_run_command','bridge_launch_process'].includes(name))return 'arbitrary_exec';
  if(['bridge_process_cancel','bridge_cancel_job'].includes(name))return 'control';
  return 'read';
}
