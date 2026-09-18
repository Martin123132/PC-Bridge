const ACCESS_MODES=new Set(['full','files_only','read_only','approve_changes']);
const CONNECTION_STATES=new Set(['stopped','connecting','connected','error']);
const cleanText=value=>String(value??'')
  .replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED KEY]')
  .replace(/(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi,'$1[REDACTED]')
  .replace(/tunnel_[0-9a-f]{32}/gi,'[REDACTED TUNNEL]')
  .replace(/[A-Za-z]:\\Users\\[^\\\r\n]+/gi,'[REDACTED USER PATH]')
  .slice(0,400);
const count=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;
const iso=value=>{if(!value)return null;const d=new Date(value);return Number.isNaN(d.valueOf())?null:d.toISOString();};
const hash=value=>/^[0-9a-f]{64}$/i.test(String(value||''))?String(value).toLowerCase():null;

export function buildSafeDiagnosticReport({version,platform,buildChannel='private-alpha',connection,credentialSaved,status,lastRequest,verifiedAt,projectCount,receiptCount,receiptHead,vaultSummary}={}){
  const c=connection||{},s=status||{},v=vaultSummary||{};
  return {
    schema_version:1,
    app:'PC Bridge',
    version:cleanText(version).slice(0,40),
    build_channel:buildChannel==='private-alpha'?'private-alpha':'unknown',
    platform:cleanText(platform).slice(0,40),
    connection:{state:CONNECTION_STATES.has(c.state)?c.state:'unknown',ready:Boolean(c.ready),detail:cleanText(c.detail)},
    credential_saved:Boolean(credentialSaved),
    access:{enabled:Boolean(s.access_enabled),mode:ACCESS_MODES.has(s.access_mode)?s.access_mode:'unknown',local_approval_required:Boolean(s.local_approval_required),arbitrary_shell_available:Boolean(s.arbitrary_shell_available),full_access_acknowledged:Boolean(s.full_access_acknowledged),workspace_guard_required_for_implicit_remote_project:Boolean(s.workspace_guard_required_for_implicit_remote_project)},
    activity:{last_request:iso(lastRequest),verified_at:iso(verifiedAt),project_count:count(projectCount),receipt_count:count(receiptCount),receipt_head:hash(receiptHead)},
    vault:{available:Boolean(s.vault_available),projects:count(v.projects),events:count(v.events),artifacts:count(v.artifacts),snapshots:count(v.snapshots),recovery_occurred:Boolean(v.recovery)}
  };
}
