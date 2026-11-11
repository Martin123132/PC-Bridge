// Read-only presentation. Never changes access, the latch, or worker admission.
export function protectionSnapshot(manager) {
  try {
    const s=manager.status();
    const states=['ordinary','starting','protected','checking','stopping','held'];
    if(!states.includes(s.state)||typeof s.protected_only!=='boolean'||
       s.host_routes_blocked!==s.protected_only||((s.state==='ordinary')===s.protected_only))throw Error('Inconsistent status');
    return {version:1,state:s.state,host_routes_blocked:s.host_routes_blocked};
  } catch {return {version:1,state:'unavailable',host_routes_blocked:null};}
}

export function accessPresentation(snapshot) {
  const p=snapshot?.chaff_protection;
  const labels={read_only:'Read only',files_only:'Files only',project_tasks:'Project Tasks',approve_changes:'Read + approve',full:'Full access'};
  const savedMode=labels[snapshot?.access_mode]||'Unknown';
  const names={starting:'Starting protection',protected:'Protected task running',checking:'Checking protected result',stopping:'Stopping protected task',held:'Host access held'};
  const known=p?.version===1&&typeof p.host_routes_blocked==='boolean'&&
    (p.state==='ordinary'?!p.host_routes_blocked:Boolean(names[p.state])&&p.host_routes_blocked);
  if(!known)return {restricted:true,state:'unavailable',label:'Protection status unavailable',savedMode,
    detail:'Bridge cannot confirm its protection status. Check Chaff locally before continuing. No access change has been made.'};
  if(p.host_routes_blocked)return {restricted:true,state:p.state,label:names[p.state],savedMode,
    detail:p.state==='held'?'Ordinary host access is still blocked. No task is available to the agent. Open Chaff to start another protected task or leave protection. Leaving protection keeps ordinary access paused.':
      p.state==='protected'?'The agent can work only in the approved isolated copy. Ordinary host files and commands remain blocked.':
      p.state==='checking'?'The result is being checked in a separate isolated machine. Ordinary host access and agent commands remain blocked.':
      p.state==='stopping'?'The protected task is stopping. Ordinary host access remains blocked.':'The isolated copy is starting. Ordinary host access remains blocked.'};
  return {restricted:false,state:snapshot.access_enabled?'ordinary':'paused',label:snapshot.access_enabled?savedMode:'Access paused',savedMode,detail:''};
}
