// Installer-owned selection, never a remote-tool argument. No cached authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const VERSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const RUNTIME_ROLES=Object.freeze({
  python:'python/python.exe', dll:'python/python313.dll',
  relay:'research/chaff/protected_worker/bridge_vm_relay.py',
  helper:'research/chaff/protected_worker/bridge_job_supervisor.py',
  kernel:'src/edge_memory_lattice/forge_process_containment.py',
  session:'research/chaff/protected_worker/session_controller.py',
  worker:'research/chaff/protected_worker/worker.py',
  checker:'research/chaff/protected_worker/result_check.py'
});
function regular(file,limit){
  for(let p=path.resolve(file);;p=path.dirname(p)){
    const s=fs.lstatSync(p);
    if(s.isSymbolicLink())throw Error('Linked Chaff registration refused');
    if(path.dirname(p)===p)break;
  }
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.nlink!==1||s.size>limit)throw Error('Invalid Chaff registration member');
  return fs.readFileSync(file);
}
function entry(e){
  if(!e||Object.keys(e).sort().join()!=='manifest_sha256,version'||typeof e.version!=='string'||!VERSION.test(e.version)||
     ['.','..'].includes(e.version)||typeof e.manifest_sha256!=='string'||!HASH.test(e.manifest_sha256))throw Error('Invalid installed Chaff version');
}
// The optional base supports isolated local tests. Production callers supply none.
export function resolveRuntime(base=path.join(process.env.LOCALAPPDATA||'', 'TwoHandsNetwork/Chaff')){
  if(!path.isAbsolute(base))throw Error('Chaff install location unavailable');
  const currentPath=path.join(base,'CURRENT.json');
  const currentBytes=regular(currentPath,4096),current=JSON.parse(currentBytes);
  if(Object.keys(current).sort().join()!=='active,previous,schema'||current.schema!==1)throw Error('Chaff setup registration unavailable');
  entry(current.active);if(current.previous!==null)entry(current.previous);
  const root=path.join(base,'versions',current.active.version),releasePath=path.join(root,'RELEASE.json');
  const bytes=regular(releasePath,4*1024*1024);
  if(sha(bytes)!==current.active.manifest_sha256)throw Error('Chaff release identity changed');
  const release=JSON.parse(bytes);
  if(release.version!==current.active.version||release.bridge_runtime_schema!==1||!release.files_sha256)throw Error('Selected Chaff release has no supported Bridge runtime');
  const files={};
  for(const [role,name] of Object.entries(RUNTIME_ROLES)){
    const expected=release.files_sha256[name];
    if(!HASH.test(expected||''))throw Error('Incomplete Chaff runtime registration');
    const file=path.join(root,name);
    if(sha(regular(file,64*1024*1024))!==expected)throw Error('Chaff runtime file changed: '+role);
    files[role]={path:file,sha256:expected};
  }
  files.release={path:releasePath,sha256:current.active.manifest_sha256};
  let accelerator='whpx';
  const settings=path.join(base,'runtime-settings.json');
  if(fs.existsSync(settings)){
    const value=JSON.parse(regular(settings,1024));
    if(Object.keys(value).sort().join()!=='accelerator,schema'||value.schema!==1||!['whpx','tcg'].includes(value.accelerator))throw Error('Invalid local VM setting');
    accelerator=value.accelerator;
  }
  if(!currentBytes.equals(regular(currentPath,4096)))throw Error('Chaff selection changed during launch; try after setup finishes');
  return {files,accelerator,version:current.active.version,manifest_sha256:current.active.manifest_sha256};
}
