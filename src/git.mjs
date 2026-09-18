import { spawn } from 'node:child_process';
import { commandEnvironment } from './commands.mjs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';

function runGitRaw(root,args,{timeoutMs=10000,maxBytes=131072,envExtra={}}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn('git',['-C',root,...args],{env:{...commandEnvironment(false),...envExtra},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,stopped=null;
    const timer=setTimeout(()=>{stopped='Git command timed out.';child.kill('SIGKILL');},timeoutMs);
    const collect=channel=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes){stopped='Git output exceeded the limit.';child.kill('SIGKILL');return;}if(channel==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
    child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,stopped});});
  });
}
async function git(root,args,options){const r=await runGitRaw(root,args,options);if(r.code!==0)throw new Error(r.stderr.trim()||r.stopped||`git ${args.join(' ')} exited ${r.code}`);return r.stdout.trim();}
async function stagedDirty(root){const r=await runGitRaw(root,['diff','--cached','--quiet','--']);if(r.code===0)return false;if(r.code===1)return true;throw new Error(r.stderr.trim()||'Could not inspect the Git index.');}

export async function gitStatus(root){
  const stdout=await git(root,['status','--short','--branch','--untracked-files=all']);
  return {repo_root:root,status:stdout,provenance:'untrusted_git_output',instruction_authority:false};
}

export async function gitDiff(root,{cached=false}={}){
  const args=['diff','--no-ext-diff','--no-color'];if(cached)args.push('--cached');args.push('--','.');
  const stdout=await git(root,args,{maxBytes:262144});
  return {repo_root:root,cached,diff:stdout,provenance:'untrusted_git_output',instruction_authority:false};
}

export async function createGitCheckpoint(root){
  if(await stagedDirty(root))throw new Error('Checkpoint refused: the real Git index has staged changes. Commit, unstage, or preserve them first.');
  const head=await git(root,['rev-parse','--verify','HEAD']);
  const tempIndex=path.join(tmpdir(),`pcbridge-index-${randomUUID()}`);
  const envExtra={GIT_INDEX_FILE:tempIndex,GIT_AUTHOR_NAME:'PC Bridge',GIT_AUTHOR_EMAIL:'pcbridge@local.invalid',GIT_COMMITTER_NAME:'PC Bridge',GIT_COMMITTER_EMAIL:'pcbridge@local.invalid'};
  try{
    await git(root,['read-tree',head],{envExtra});
    // Tracked worktree only: no untracked files are added or removed by this checkpoint system.
    await git(root,['add','-u','--','.'],{envExtra,timeoutMs:30000});
    const tree=await git(root,['write-tree'],{envExtra});
    const commit=await git(root,['commit-tree',tree,'-p',head,'-m',`PC Bridge checkpoint ${new Date().toISOString()}`],{envExtra});
    return {repo_root:root,head,tree,commit,tracked_only:true,created_at:new Date().toISOString()};
  } finally { await rm(tempIndex,{force:true}).catch(()=>{}); }
}

export async function rollbackGitCheckpoint(root,checkpoint){
  const currentHead=await git(root,['rev-parse','--verify','HEAD']);
  if(currentHead!==checkpoint.head)throw new Error('Rollback refused: repository HEAD changed since this checkpoint.');
  if(await stagedDirty(root))throw new Error('Rollback refused: the real Git index has staged changes.');
  await git(root,['cat-file','-e',`${checkpoint.commit}^{commit}`]);
  await git(root,['restore',`--source=${checkpoint.commit}`,'--worktree','--','.'],{timeoutMs:30000});
  return {repo_root:root,checkpoint_id:checkpoint.id,restored_commit:checkpoint.commit,head:currentHead,tracked_only:true,status:(await gitStatus(root)).status};
}
