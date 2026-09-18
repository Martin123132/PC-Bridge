import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const now=()=>new Date().toISOString();
const safeName=value=>String(value||'workspace').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'workspace';
const stamp=value=>value.replace(/[:.]/g,'-');
const blockedDir=name=>/^(\.git|node_modules|dist|build|vendor|\.venv|__pycache__)$/i.test(name);
async function hashFile(filename){return await new Promise((resolve,reject)=>{const h=createHash('sha256'),s=createReadStream(filename);s.on('data',c=>h.update(c));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));});}
function git(root,args){return spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});}
async function fallbackFiles(root){const out=[];let count=0;const walk=async(folder,prefix='')=>{for(const entry of await readdir(folder,{withFileTypes:true})){if(count>=5000)return;if(entry.isSymbolicLink()||blockedDir(entry.name))continue;const rel=prefix?`${prefix}/${entry.name}`:entry.name,full=path.join(folder,entry.name);if(entry.isDirectory()){await walk(full,rel);continue;}if(!entry.isFile())continue;const info=await lstat(full);if(info.size>64*1024*1024)continue;out.push(rel);count++;}};await walk(root);return out;}
export async function createSourceManifestSnapshot({project,dataDir,label='Workspace snapshot'}={}){
  if(!project?.root)throw Error('A workspace is required for a snapshot.');const root=path.resolve(project.root);if(await realpath(root)!==root)throw Error('Snapshot root must be a real local folder.');
  const created=now(),outputDir=path.join(dataDir,'vault','snapshots',`${stamp(created)}-${safeName(project.name)}`);await mkdir(outputDir,{recursive:true});
  const headRun=git(root,['rev-parse','HEAD']),trackedRun=git(root,['ls-files','-z']),statusRun=git(root,['status','--porcelain=v1']);const isGit=headRun.status===0&&trackedRun.status===0;
  const files=isGit?trackedRun.stdout.split('\0').filter(Boolean):await fallbackFiles(root);const entries=[];let totalBytes=0;
  for(const rel of files){const full=path.join(root,...rel.split('/'));try{const info=await lstat(full);if(!info.isFile()||info.isSymbolicLink())continue;entries.push({path:rel,size:info.size,sha256:await hashFile(full)});totalBytes+=info.size;}catch{}}
  const manifest={snapshot_version:1,kind:'source_manifest',label,created_at:created,project:{id:project.id,name:project.name,root},git:{is_repo:isGit,head:isGit?headRun.stdout.trim():null,status:isGit?statusRun.stdout.split(/\r?\n/).filter(Boolean).slice(0,500):[]},file_count:entries.length,total_bytes:totalBytes,files:entries};
  const text=JSON.stringify(manifest,null,2)+'\n',manifestPath=path.join(outputDir,'source-manifest.json');await writeFile(manifestPath,text,{encoding:'utf8',flag:'wx'});const sha256=createHash('sha256').update(text).digest('hex');
  return {project_id:project.id,kind:'source_manifest',label,status:'ready',root,output_path:manifestPath,sha256,created_at:created,metadata:{file_count:entries.length,total_bytes:totalBytes,git_head:manifest.git.head,git_dirty:manifest.git.status.length>0,adapter:'builtin-manifest',repomori:false}};
}
