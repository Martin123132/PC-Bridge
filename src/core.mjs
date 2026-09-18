import { EventEmitter } from 'node:events';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, realpath, readdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { runCommand, runManagedCommand, runManagedNodeTask } from './commands.mjs';
import { gitStatus as readGitStatus, gitDiff as readGitDiff, createGitCheckpoint, rollbackGitCheckpoint } from './git.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const redact = value => String(value).replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED KEY]').replace(/(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, '$1[REDACTED]');
const MAX_FILE = 128 * 1024;
const JOB_TTL = 15 * 60 * 1000;
const blocked = /^(\.|node_modules$|vendor$|dist$|build$)|(?:secret|credential|password|token)(?:s)?(?:[._-]|$)|^(?:id_rsa|id_ed25519|authorized_keys)$|\.(?:pem|key|pfx|p12|clixml|encrypted)$/i;
const allowedExt = new Set(['.txt','.md','.json','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.css','.html','.yml','.yaml','.toml','.csv','.ps1','.cmd','.bat','.sh','.c','.h','.cpp','.hpp','.rs','.go','.sql','.xml','.ini','.log']);
const looksSecret = value => /sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value);
const now = () => new Date().toISOString();
const ACCESS_MODES = new Set(['full','project_tasks','read_only','files_only','approve_changes']);
const MUTATING_KINDS = new Set(['write','test','project_task','command','process']);
const EXECUTION_KINDS = new Set(['test','project_task','command','process']);
const ARBITRARY_EXECUTION_KINDS = new Set(['command','process']);
const PROCESS_LIKE_KINDS = new Set(['process','project_task']);
const inside=(root,target)=>{const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
async function nearestGitRoot(start){let current=path.resolve(start);for(;;){try{const info=await lstat(path.join(current,'.git'));if(info.isDirectory()||info.isFile())return current;}catch{}const parent=path.dirname(current);if(parent===current)return null;current=parent;}}

export function relativeName(name) {
  if (typeof name !== 'string' || name.length > 200 || /[\\:\x00-\x1f]/.test(name) || path.posix.isAbsolute(name)) throw Error('Use a relative path with forward slashes.');
  const parts = name.split('/');
  if (!parts.length || parts.length > 10 || parts.some(p => !p || p === '..' || p.endsWith('.') || p.endsWith(' ') || /[<>"|?*]/.test(p) || blocked.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('This path is outside the permitted source-file rules.');
  if (!allowedExt.has(path.extname(name).toLowerCase())) throw Error('Only supported text/source file types are accessible.');
  return name;
}

export async function atomicJson(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temp, filename);
}

export class BridgeCore extends EventEmitter {
  constructor({ dataDir, workspaceDir = path.join(dataDir, 'Workspace'), nodeExecutable = process.execPath, electronNode = false, runner = runNodeTests, commandRunner = runCommand, processRunner = runManagedCommand, taskRunner = runManagedNodeTask, vault = null } = {}) {
    super(); this.dataDir = dataDir; this.nodeExecutable = nodeExecutable; this.electronNode = electronNode; this.runner = runner;
    this.projects = []; this.jobs = []; this.checkpoints = []; this.leaseUntil = 0; this.lastSeen = null; this.verifiedAt = null;
    this.verificationCode = randomBytes(4).toString('hex').toUpperCase(); this.auditHash = '0'.repeat(64); this.auditCount = 0;
    this.queue = Promise.resolve(); this.controllers = new Map(); this.instance = randomUUID();
    this.workspaceDir = workspaceDir; this.trustedAccess = false; this.accessMode = 'full'; this.fullAccessAcknowledged = false; this.defaultProjectId = null; this.workspaceProjectId = null;
    this.commandRunner = commandRunner; this.processRunner = processRunner; this.taskRunner = taskRunner; this.executions = new Map(); this.projectQueues = new Map(); this.vault = vault; this.vaultError = null;
    this.workspaceGuard=randomBytes(16).toString('hex');this.workspaceGuardExpiresAt=0;
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(path.join(this.dataDir, 'backups'), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, 'workspace-state.json'), 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.projects) || !Array.isArray(saved.jobs)) throw Error('Invalid saved state.');
      this.projects = saved.projects; this.jobs = saved.jobs; this.checkpoints = Array.isArray(saved.checkpoints) ? saved.checkpoints : [];
      for (const project of this.projects) { if (!Array.isArray(project.project_tasks)) project.project_tasks=[]; if (!project.task_grant || typeof project.task_grant!=='object') project.task_grant=null; }
      this.trustedAccess = saved.trusted_access === true; this.accessMode = ACCESS_MODES.has(saved.access_mode) ? saved.access_mode : 'full'; this.fullAccessAcknowledged = saved.full_access_acknowledged === true; if(this.trustedAccess&&this.accessMode==='full'&&!this.fullAccessAcknowledged)this.trustedAccess=false; this.defaultProjectId = saved.default_project_id ?? null;
      for (const job of this.jobs) if (['pending','queued','running'].includes(job.state)) { job.state = 'interrupted'; job.error = 'App restarted. Check the result before submitting a new request; interrupted work is never replayed.'; }
    } catch (error) { if (error.code !== 'ENOENT') throw Error('Saved state could not be read. No access was granted.'); }
    try {
      const audit = await readFile(path.join(this.dataDir, 'receipts.jsonl'), 'utf8');
      for (const line of audit.split('\n').filter(Boolean)) {
        const item = JSON.parse(line); const { hash, ...body } = item;
        if (body.previous !== this.auditHash || digest(JSON.stringify(body)) !== hash) throw Error('Receipt chain mismatch.');
        this.auditHash = hash; this.auditCount++;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw Error('Receipt integrity check failed. Work is disabled; preserve the data folder for investigation.'); }
    await mkdir(this.workspaceDir, { recursive: true });
    let workspaceProject = this.projects.find(p => p.root === this.workspaceDir);
    if (!workspaceProject) workspaceProject = await this.addProject(this.workspaceDir, 'Workspace');
    this.workspaceProjectId = workspaceProject.id;
    if (!this.projects.some(p => p.id === this.defaultProjectId)) this.defaultProjectId = workspaceProject.id;
    await this.save(); return this;
  }
  serial(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async save() { await atomicJson(path.join(this.dataDir, 'workspace-state.json'), { version: 1, trusted_access: this.trustedAccess, access_mode: this.accessMode, full_access_acknowledged: this.fullAccessAcknowledged, default_project_id: this.defaultProjectId, projects: this.projects, jobs: this.jobs, checkpoints: this.checkpoints.slice(-20) }); try{this.vault?.sync({projects:this.projects,jobs:this.jobs,checkpoints:this.checkpoints});this.vaultError=null;}catch(error){this.vaultError=redact(error.message);} this.emit('change'); }
  async receipt(type, details = {}) {
    const body = { time: now(), previous: this.auditHash, type, ...details };
    const hash = digest(JSON.stringify(body));
    const file = await open(path.join(this.dataDir, 'receipts.jsonl'), 'a', 0o600);
    try { await file.writeFile(JSON.stringify({ ...body, hash }) + '\n'); await file.sync(); } finally { await file.close(); }
    this.auditHash = hash; this.auditCount++; this.emit('change'); return hash;
  }
  arm(minutes = 60) {
    if (![30,60,120,240].includes(minutes)) throw Error('Choose a supported session length.');
    clearTimeout(this.leaseTimer); this.leaseUntil = Date.now() + minutes * 60000;
    this.leaseTimer = setTimeout(() => void this.pause().catch(() => { this.leaseUntil = 0; this.emit('change'); }), minutes * 60000);
    this.leaseTimer.unref(); this.emit('change');
  }
  validMode(mode) { if (!ACCESS_MODES.has(mode)) throw Error('Choose Full access, Project Tasks, Files only, Read only, or Read + approve changes.'); return mode; }
  requireFullAccessAcknowledgement(mode){if(mode==='full'&&!this.fullAccessAcknowledged)throw Error('Full access has not been acknowledged locally. Confirm the Full access warning in PC Bridge first.');}
  async acknowledgeFullAccess(){return this.serial(async()=>{if(this.fullAccessAcknowledged)return this.status();this.fullAccessAcknowledged=true;await this.receipt('full_access_warning_acknowledged');await this.save();return this.status();});}
  async setAccessMode(mode) {
    mode = this.validMode(mode);this.requireFullAccessAcknowledgement(mode);
    return this.serial(async () => {
      this.accessMode = mode;
      if (mode !== 'full') {
        for (const job of this.jobs) {
          if (!MUTATING_KINDS.has(job.kind)) continue;
          const execution=EXECUTION_KINDS.has(job.kind);
          if(mode==='files_only' && !execution)continue;
          if(mode==='project_tasks'){
            if(!ARBITRARY_EXECUTION_KINDS.has(job.kind))continue;
            if(job.state==='running'){this.controllers.get(job.id)?.abort();job.state='cancelled';}
            else if(job.state==='queued'||job.state==='pending')job.state='cancelled';
            continue;
          }
          if(mode==='approve_changes'){
            if(job.state==='running'){this.controllers.get(job.id)?.abort();job.state='cancelled';}
            else if(job.state==='queued')job.state='pending';
            continue;
          }
          if(job.state==='running'){this.controllers.get(job.id)?.abort();job.state='cancelled';}
          else if(job.state==='queued'||job.state==='pending')job.state='cancelled';
        }
      }
      await this.receipt('access_mode_changed', { mode }); await this.save(); return this.status();
    });
  }
  async enable(mode = this.accessMode) {
    mode = this.validMode(mode);this.requireFullAccessAcknowledgement(mode);
    return this.serial(async () => { this.trustedAccess = true; this.accessMode = mode; await this.receipt('trusted_access_enabled', { mode }); await this.save(); return this.status(); });
  }
  async pause({ shutdown = false } = {}) {
    clearTimeout(this.leaseTimer); this.leaseUntil = 0; if (!shutdown) this.trustedAccess = false;
    for (const controller of this.controllers.values()) controller.abort();
    return this.serial(async () => { for (const job of this.jobs) if (['pending','queued','running'].includes(job.state)) job.state = 'cancelled'; await this.receipt(shutdown ? 'app_stopped' : 'access_paused'); await this.save(); });
  }
  checkAccess() { if (!this.trustedAccess && Date.now() >= this.leaseUntil) throw Error('Access is paused. Resume access in PC Bridge.'); }
  checkRequestKind(kind) {
    this.checkAccess();
    if (MUTATING_KINDS.has(kind) && this.accessMode === 'read_only') throw Error('PC Bridge is in Read only mode. Writes, commands, tests and managed processes are blocked locally.');
    if (EXECUTION_KINDS.has(kind) && this.accessMode === 'files_only') throw Error('PC Bridge is in Files only mode. Commands, tests, project tasks and managed processes are blocked locally; shared file reads/writes remain available.');
    if (ARBITRARY_EXECUTION_KINDS.has(kind) && this.accessMode === 'project_tasks') throw Error('PC Bridge is in Project Tasks mode. Arbitrary commands and managed processes are blocked; only locally pinned project tasks/tests may execute.');
  }
  project(id) { const p = this.projects.find(p => p.id === (id || this.defaultProjectId)); if (!p) throw Error('Project is not shared.'); return p; }
  rotateWorkspaceGuard(){this.workspaceGuard=randomBytes(16).toString('hex');this.workspaceGuardExpiresAt=0;}
  remoteStatus(){this.workspaceGuardExpiresAt=Date.now()+15*60*1000;return {...this.status(),workspace_guard:this.workspaceGuard,workspace_guard_expires_at:new Date(this.workspaceGuardExpiresAt).toISOString(),workspace_guard_policy:'If project_id is omitted, inspect this active workspace and echo workspace_guard. The guard expires after 15 minutes and is invalidated when the active workspace changes or PC Bridge restarts.'};}
  remoteProjectId(id,guard){this.checkAccess();if(id)return this.project(id).id;if(typeof guard!=='string'||guard!==this.workspaceGuard||Date.now()>=this.workspaceGuardExpiresAt)throw Error('Active workspace is not freshly acknowledged. Call bridge_status, inspect the active workspace, then retry with its workspace_guard; or supply project_id explicitly.');return this.project().id;}
  publicProjects() { return this.projects.map(({ id, name, task, task_grant, project_tasks=[] }) => ({ id, name, test_task: task ? 'node_tests' : null, test_task_granted:Boolean(task&&task_grant?.path===task), project_task_count:project_tasks.length, active: id === this.defaultProjectId })); }
  status() {
    const enabled=this.trustedAccess || Date.now() < this.leaseUntil;
    const modeText=this.accessMode==='full'?'Full access: reads, writes, commands, tests and managed processes can run directly as your Windows user.':this.accessMode==='project_tasks'?'Project Tasks: protected file edits plus locally pinned project tasks/tests may run; arbitrary PowerShell, cmd, Node command text and arbitrary managed processes are blocked.':this.accessMode==='files_only'?'Files only: shared workspace file reads/writes are available with file-tool protections; commands, tests, project tasks and managed processes are blocked locally.':this.accessMode==='read_only'?'Read only: shared workspace text can be listed/read; writes and execution are blocked.':'Read + approve changes: reads are automatic; every write, command, test, project task and managed process waits for local approval before execution.';
    let vault_summary=null;try{vault_summary=this.vault?.summary()??null;}catch{} return { app:'PC Bridge', version:'0.5.16', instance_id:this.instance, access_enabled:enabled, access_expires_at:this.trustedAccess?null:this.leaseUntil?new Date(this.leaseUntil).toISOString():null, access_mode:this.accessMode, projects:this.publicProjects(), default_project_id:this.defaultProjectId, workspace_path:this.project().root, local_approval_required:this.accessMode==='approve_changes', arbitrary_shell_available:['full','approve_changes'].includes(this.accessMode), project_task_execution_available:['full','approve_changes','project_tasks'].includes(this.accessMode), vault_available:Boolean(this.vault), vault_summary, build_channel:'private-alpha', full_access_acknowledged:this.fullAccessAcknowledged, workspace_guard_required_for_implicit_remote_project:true, access_model:modeText+' PC Bridge is not an OS sandbox; Pause access revokes all work.' };
  }
  snapshot() { return { ...this.status(), projects: this.projects, jobs: this.jobs.map(j => ({ ...j, content: j.content, before: j.before })), checkpoints: this.checkpoints.slice(-20), vault_error:this.vaultError, last_seen: this.lastSeen, verified_at: this.verifiedAt, verification_code: this.verificationCode, receipts: this.auditCount, receipt_head: this.auditHash }; }
  async addProject(root, name, task = null) {
    return this.serial(async () => {
      const resolved = path.resolve(root); const info = await lstat(resolved);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) throw Error('Choose a real folder, not a linked folder.');
      if ([path.parse(resolved).root, os.homedir(), process.env.USERPROFILE, process.env.SystemRoot, process.env.ProgramFiles].filter(Boolean).some(p => path.resolve(p).toLowerCase() === resolved.toLowerCase()) || resolved === this.dataDir || this.dataDir.startsWith(resolved + path.sep)) throw Error('Choose a dedicated project folder, not a drive, home, system or app-data folder.');
      if (this.projects.some(p => p.root.toLowerCase() === resolved.toLowerCase())) throw Error('That folder is already shared.');
      const project = { id: randomUUID(), name: String(name || path.basename(root)).slice(0,80), root: resolved, identity: `${info.dev}:${info.ino}`, task, task_grant:null, project_tasks:[] };
      if (task) { relativeName(task); if (!/\.(?:mjs|cjs|js)$/.test(task)) throw Error('Test entry must be a JavaScript file.'); }
      this.projects.push(project); await this.receipt('project_shared', { project_id: project.id, name: project.name }); await this.save(); return project;
    });
  }
  async createProject(root, name) {
    return this.serial(async () => {
      const resolved=path.resolve(root);const parent=path.dirname(resolved);const baseName=path.basename(resolved);
      const badChars=new Set(['<','>',':','"','/','\\','|','?','*']);
      const badName=!baseName||baseName.length>80||[...baseName].some(ch=>badChars.has(ch)||ch.charCodeAt(0)<32)||baseName.endsWith('.')||baseName.endsWith(' ')||['con','prn','aux','nul','com1','com2','com3','com4','com5','com6','com7','com8','com9','lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9'].includes(baseName.toLowerCase().split('.')[0]);
      if(badName)throw Error('Choose a normal workspace folder name.');
      try{await lstat(resolved);throw Error('That folder already exists. Use Add existing instead.');}catch(error){if(error.code!=='ENOENT')throw error;}
      const parentInfo=await lstat(parent);if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||await realpath(parent)!==parent)throw Error('Choose a real parent folder, not a linked folder.');
      if([path.parse(resolved).root,os.homedir(),process.env.USERPROFILE,process.env.SystemRoot,process.env.ProgramFiles].filter(Boolean).some(p=>path.resolve(p).toLowerCase()===resolved.toLowerCase())||resolved===this.dataDir||this.dataDir.startsWith(resolved+path.sep))throw Error('Choose a dedicated project folder, not a drive, home, system or app-data folder.');
      if(this.projects.some(p=>p.root.toLowerCase()===resolved.toLowerCase()))throw Error('That workspace is already shared.');
      let project=null,created=false;
      try{
        await mkdir(resolved,{recursive:false});created=true;const info=await lstat(resolved);
        if(!info.isDirectory()||info.isSymbolicLink()||await realpath(resolved)!==resolved)throw Error('Workspace creation did not produce a normal local folder.');
        project={id:randomUUID(),name:String(name||baseName).slice(0,80),root:resolved,identity:String(info.dev)+':'+String(info.ino),task:null,task_grant:null,project_tasks:[]};
        this.projects.push(project);this.defaultProjectId=project.id;this.rotateWorkspaceGuard();await this.receipt('project_created',{project_id:project.id,name:project.name,active:true});await this.save();return project;
      }catch(error){if(project)this.projects=this.projects.filter(p=>p.id!==project.id);if(created){try{await rm(resolved,{recursive:false,force:false});}catch{}}throw error;}
    });
  }
  async removeProject(id) {
    return this.serial(async () => {
      if (id === this.workspaceProjectId) throw Error('The ready-to-use workspace stays available. Pause access to disconnect all work.');
      this.project(id); this.projects = this.projects.filter(p => p.id !== id);
      if (this.defaultProjectId === id) { this.defaultProjectId = this.workspaceProjectId; this.rotateWorkspaceGuard(); }
      for (const job of this.jobs.filter(j => j.project_id === id)) { this.controllers.get(job.id)?.abort(); if (['pending','queued','running'].includes(job.state)) job.state = 'cancelled'; }
      await this.receipt('project_unshared', { project_id: id }); await this.save();
    });
  }
  async setDefaultProject(id) {
    return this.serial(async()=>{const project=this.project(id);this.defaultProjectId=project.id;this.rotateWorkspaceGuard();await this.receipt('default_project_changed',{project_id:project.id});await this.save();return this.status();});
  }
  async setTask(id, task) {
    const project = this.project(id); relativeName(task);
    if (!/\.(?:mjs|cjs|js)$/.test(task)) throw Error('Test entry must be a JavaScript file.');
    await this.safePath(id, task);
    if (this.jobs.some(j => j.project_id === id && j.state === 'running')) throw Error('Wait for the running request before changing the test entry.');
    const taskFile=await this.read(id,task,{skipAccess:true});
    const projectFingerprint=await this.fingerprint(id,{local:true});
    return this.serial(async () => {
      project.task = task;
      project.task_grant={path:task,sha256:taskFile.sha256,project_fingerprint:projectFingerprint,granted_at:now()};
      for (const job of this.jobs) if (job.project_id === id && job.kind === 'test' && ['queued','pending'].includes(job.state)) job.state = 'cancelled';
      await this.receipt('test_entry_selected', { project_id: id, task, sha256:taskFile.sha256, project_fingerprint:projectFingerprint }); await this.save();
    });
  }
  async grantProjectTask(id, task, name = null) {
    const project=this.project(id);relativeName(task);
    if(!/\.(?:mjs|cjs|js)$/.test(task))throw Error('Project task entry must be a JavaScript file.');
    await this.safePath(id,task);
    if(this.jobs.some(j=>j.project_id===id&&j.state==='running'))throw Error('Wait for the running request before changing project-task grants.');
    const taskFile=await this.read(id,task,{skipAccess:true});const projectFingerprint=await this.fingerprint(id,{local:true});
    return this.serial(async()=>{
      if(!Array.isArray(project.project_tasks))project.project_tasks=[];
      let grant=project.project_tasks.find(t=>t.path===task);
      if(!grant){grant={id:randomUUID(),path:task};project.project_tasks.push(grant);}
      grant.name=String(name||path.basename(task)).slice(0,80);grant.sha256=taskFile.sha256;grant.project_fingerprint=projectFingerprint;grant.granted_at=now();grant.max_runtime_seconds=3600;
      for(const job of this.jobs)if(job.project_id===id&&job.kind==='project_task'&&job.task_id===grant.id&&['queued','pending'].includes(job.state))job.state='cancelled';
      await this.receipt('project_task_granted',{project_id:id,task_id:grant.id,path:grant.path,sha256:grant.sha256,project_fingerprint:grant.project_fingerprint});await this.save();return {...grant};
    });
  }
  async revokeProjectTask(id, taskId) {
    return this.serial(async()=>{
      const project=this.project(id);const grant=(project.project_tasks||[]).find(t=>t.id===taskId);if(!grant)throw Error('Project task grant not found.');
      for(const job of this.jobs){if(job.project_id!==id||job.kind!=='project_task'||job.task_id!==taskId||!['pending','queued','running'].includes(job.state))continue;if(job.state==='running')this.controllers.get(job.id)?.abort();job.state='cancelled';}
      project.project_tasks=project.project_tasks.filter(t=>t.id!==taskId);await this.receipt('project_task_revoked',{project_id:id,task_id:taskId,path:grant.path});await this.save();return this.projectTasks(id,{skipAccess:true});
    });
  }
  projectTasks(id,{skipAccess=false}={}){if(!skipAccess)this.checkAccess();const project=this.project(id);return{tasks:(project.project_tasks||[]).map(({id,name,path,sha256,project_fingerprint,granted_at,max_runtime_seconds})=>({id,name,path,sha256,project_fingerprint,granted_at,max_runtime_seconds})),provenance:'local_policy_metadata',instruction_authority:false};}

  async safePath(id, filename, missing = false) {
    const project = this.project(id);
    // Absolute local paths are available under the saved trusted-PC choice. The
    // source-file checks reduce accidents, but commands are deliberately not jailed.
    const absolute = path.isAbsolute(filename);
    if (absolute) {
      if (!this.trustedAccess || this.accessMode !== 'full' || /^[/\\]{2}/.test(filename)) throw Error('Absolute local paths require Full access; network/device paths are not supported.');
      const resolved = path.resolve(filename); const base = path.parse(resolved).root;
      relativeName(path.relative(base, resolved).split(path.sep).join('/'));
    } else relativeName(filename);
    const rootInfo = await lstat(project.root);
    if (rootInfo.isSymbolicLink() || `${rootInfo.dev}:${rootInfo.ino}` !== project.identity || await realpath(project.root) !== project.root) throw Error('Shared folder identity changed. Share it again locally.');
    let current = absolute ? path.parse(path.resolve(filename)).root : project.root;
    const parts = absolute ? path.relative(current, path.resolve(filename)).split(path.sep) : filename.split('/');
    for (let i=0; i<parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (i < parts.length-1 && !info.isDirectory())) throw Error('Linked paths are not accessible.');
        if (i === parts.length-1 && (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE)) throw Error('Only small, regular, unlinked text files are accessible.');
      } catch (error) { if (!(missing && i === parts.length-1 && error.code === 'ENOENT')) throw error; }
    }
    return current;
  }
  async read(id, filename, {skipAccess=false} = {}) {
    if(!skipAccess)this.checkAccess(); const target = await this.safePath(id, filename); const original = await lstat(target); const handle = await open(target, 'r');
    let content;
    try {
      const actual = await handle.stat(); if (actual.ino !== original.ino || actual.nlink !== 1 || actual.size > MAX_FILE) throw Error('File changed during reading.');
      const buffer = Buffer.alloc(MAX_FILE + 1); let used = 0;
      while (used < buffer.length) { const {bytesRead} = await handle.read(buffer,used,buffer.length-used,used); if (!bytesRead) break; used += bytesRead; }
      const bytes = buffer.subarray(0,used);
      if (used > MAX_FILE || !isUtf8(bytes)) throw Error('File is too large or not UTF-8 text.');
      content = bytes.toString('utf8');
    }
    finally { await handle.close(); }
    if (Buffer.byteLength(content) > MAX_FILE || content.includes('\0')) throw Error('File is too large or not text.');
    if (looksSecret(content)) throw Error('Possible credential content detected. This file was not returned.');
    return { path: filename, content, sha256: digest(content), provenance:'untrusted_file_content', instruction_authority:false };
  }
  async files(id, {skipAccess=false} = {}) {
    if(!skipAccess)this.checkAccess(); const project = this.project(id); const result = []; let examined = 0, truncated = false;
    const walk = async (folder, prefix = '', depth = 0) => {
      if (depth > 9 || result.length >= 500 || examined > 3000) { truncated = true; return; }
      const folderInfo = await lstat(folder);
      if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || await realpath(folder) !== folder) throw Error('Folder changed during listing.');
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (++examined > 3000 || result.length >= 500) break;
        if (blocked.test(entry.name) || entry.isSymbolicLink()) continue;
        const rel = prefix + entry.name;
        if (entry.isDirectory()) { await walk(path.join(folder, entry.name), rel+'/', depth+1); continue; }
        try { await this.safePath(id, rel); result.push(rel); } catch {}
      }
    };
    const rootInfo = await lstat(project.root);
    if (rootInfo.isSymbolicLink() || `${rootInfo.dev}:${rootInfo.ino}` !== project.identity) throw Error('Shared folder identity changed.');
    await walk(project.root); return { files: result.sort(), truncated: truncated || result.length >= 500 || examined > 3000 };
  }
  async executionLane(project,cwd=project.root){const resolved=path.resolve(cwd);const git=await nearestGitRoot(resolved);if(git)return git;if(inside(project.root,resolved))return project.root;return resolved;}
  async gitStatus(id){this.checkAccess();const project=this.project(id);const root=await nearestGitRoot(project.root);if(!root)throw Error('The active workspace is not inside a Git repository.');return readGitStatus(root);}
  async gitDiff(id,{cached=false}={}){this.checkAccess();const project=this.project(id);const root=await nearestGitRoot(project.root);if(!root)throw Error('The active workspace is not inside a Git repository.');return readGitDiff(root,{cached});}
  async createCheckpoint(id){this.checkAccess();const project=this.project(id);const root=await nearestGitRoot(project.root);if(!root)throw Error('The active workspace is not inside a Git repository.');const lane=root.toLowerCase();if(this.jobs.some(j=>(j.lane_key??'').toLowerCase()===lane&&j.state==='running'))throw Error('Checkpoint refused while this repository has a running job.');const created=await createGitCheckpoint(root);return this.serial(async()=>{const checkpoint={id:randomUUID(),project_id:project.id,...created};this.checkpoints.push(checkpoint);if(this.checkpoints.length>20)this.checkpoints=this.checkpoints.slice(-20);await this.receipt('git_checkpoint_created',{checkpoint_id:checkpoint.id,project_id:project.id,head:checkpoint.head,commit:checkpoint.commit});await this.save();return checkpoint;});}
  async rollbackCheckpoint(checkpointId){this.checkAccess();const checkpoint=this.checkpoints.find(c=>c.id===checkpointId);if(!checkpoint)throw Error('Checkpoint not found.');const lane=checkpoint.repo_root.toLowerCase();if(this.jobs.some(j=>(j.lane_key??'').toLowerCase()===lane&&j.state==='running'))throw Error('Rollback refused while this repository has a running job.');const result=await rollbackGitCheckpoint(checkpoint.repo_root,checkpoint);await this.serial(async()=>{await this.receipt('git_checkpoint_rolled_back',{checkpoint_id:checkpoint.id,project_id:checkpoint.project_id,commit:checkpoint.commit});await this.save();});return result;}
  async fingerprint(id,{local=false}={}) { const listing = await this.files(id,{skipAccess:local}); if (listing.truncated) throw Error('Project Tasks require a small project whose bridge-visible source set can be fingerprinted completely.'); const entries=[]; for(const name of listing.files) entries.push([name,(await this.read(id,name,{skipAccess:local})).sha256]); return digest(JSON.stringify(entries)); }
  async prepare(kind, input) {
    return this.serial(async () => {
      this.checkRequestKind(kind); const project = this.project(input.project_id);
      const source_client_id=typeof input._source_client_id==='string'?input._source_client_id.slice(0,80):null;
      const source_provider=typeof input._source_provider==='string'?input._source_provider.slice(0,40):null;
      const source_transport=typeof input._source_transport==='string'?input._source_transport.slice(0,24):null;
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.request_key || '')) throw Error('Use a unique request_key (8–80 letters, digits, dashes or underscores).');
      const signature = digest(JSON.stringify({ kind, ...input }));
      const existing = this.jobs.find(j => j.request_key === input.request_key);
      if (existing) { if(existing.signature !== signature) throw Error('request_key was already used for different input.'); return this.publicJob(existing); }
      if (this.jobs.filter(j => ['pending','queued','running'].includes(j.state)).length >= 20) throw Error('20 requests are already active. Wait for them to finish.');
      let extra; let lane_key=project.root.toLowerCase();
      if (kind === 'write') {
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_FILE || looksSecret(input.content) || input.content.includes('\0')) throw Error('Content is oversized, binary or may contain credentials.');
        await this.safePath(project.id, input.path, true); let before = null;
        try { before = await this.read(project.id, input.path); } catch(error) { if(error.code !== 'ENOENT') throw error; }
        if ((before?.sha256 ?? null) !== input.expected_sha256) throw Error('File changed or expected hash is wrong. Read it again. Use null only for a new file.');
        extra = { path: input.path, content: input.content, before: before?.content ?? null, before_sha256: before?.sha256 ?? null, after_sha256: digest(input.content) };
      } else if (kind === 'test') {
        if (!project.task) throw Error('No test entry has been selected locally for this project.');
        await this.safePath(project.id, project.task);
        const fingerprint=await this.fingerprint(project.id);
        if(this.accessMode==='project_tasks'){
          const grant=project.task_grant;const taskSha=(await this.read(project.id,project.task)).sha256;
          if(!grant||grant.path!==project.task||grant.sha256!==taskSha||grant.project_fingerprint!==fingerprint)throw Error('The saved test changed since local approval. Re-select it in PC Bridge before running it in Project Tasks mode.');
        }
        extra = { task: project.task, fingerprint };
      } else if (kind === 'project_task') {
        const grant=(project.project_tasks||[]).find(t=>t.id===input.task_id);if(!grant)throw Error('Project task is not locally granted.');
        await this.safePath(project.id,grant.path);const taskSha=(await this.read(project.id,grant.path)).sha256;const projectFingerprint=await this.fingerprint(project.id);
        if(taskSha!==grant.sha256||projectFingerprint!==grant.project_fingerprint)throw Error('Project task grant is stale because the task or bridge-visible project source changed. Re-approve the task locally in PC Bridge.');
        extra={task_id:grant.id,task_name:grant.name,task:grant.path,task_sha256:grant.sha256,grant_fingerprint:grant.project_fingerprint,max_runtime_seconds:grant.max_runtime_seconds||3600,stdout_tail:'',stderr_tail:'',output_truncated:false};
      } else if (kind === 'command' || kind === 'process') {
        if (!this.trustedAccess) throw Error('Commands require PC Bridge access to be enabled.');
        if (!['powershell','cmd','node'].includes(input.shell) || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32768 || input.command.includes('\0') || looksSecret(input.command)) throw Error('Choose powershell, cmd or node and provide command text without embedded credentials (maximum 32768 characters).');
        const cwd = path.resolve(project.root, input.cwd || '.');
        if (/^[/\\]{2}/.test(cwd) || !(await lstat(cwd)).isDirectory() || await realpath(cwd) !== cwd) throw Error('Choose an existing local working folder, not a linked or network folder.');
        lane_key=(await this.executionLane(project,cwd)).toLowerCase();
        if(kind==='command'){const timeout=input.timeout_seconds??60;if(!Number.isInteger(timeout)||timeout<1||timeout>300)throw Error('Command timeout must be 1–300 seconds.');extra={shell:input.shell,command:input.command,cwd,timeout_seconds:timeout};}
        else {const max_runtime=input.max_runtime_seconds??3600;if(!Number.isInteger(max_runtime)||max_runtime<1||max_runtime>21600)throw Error('Managed process runtime must be 1–21600 seconds.');extra={shell:input.shell,command:input.command,cwd,max_runtime_seconds:max_runtime,stdout_tail:'',stderr_tail:'',output_truncated:false};}
      } else throw Error('Unknown request type.');
      const needsApproval = MUTATING_KINDS.has(kind) && this.accessMode === 'approve_changes';
      const job = { id: randomUUID(), kind, project_id: project.id, project_name: project.name, lane_key, request_key: input.request_key, signature, source_client_id, source_provider, source_transport, state: needsApproval ? 'pending' : 'queued', approved: !needsApproval, created_at: now(), expires_at: new Date(Date.now()+JOB_TTL).toISOString(), ...extra };
      await this.receipt(needsApproval ? 'request_pending_approval' : 'request_queued', { job_id: job.id, project_id: project.id, kind, input_sha256: signature, source_client_id, source_provider, source_transport });
      this.jobs.push(job); await this.save(); return this.publicJob(job);
    });
  }
  async schedule(id, { wait = false } = {}) {
    const job=this.jobs.find(j=>j.id===id); if(!job)throw Error('Job not found.');
    let execution=this.executions.get(id);
    if(!execution && job.state==='queued'){
      const lane=job.lane_key??job.project_id;
      const previous=this.projectQueues.get(lane) ?? Promise.resolve();
      execution=previous.catch(()=>{}).then(()=>this.execute(id)).catch(async error=>{
        await this.serial(async()=>{const current=this.jobs.find(j=>j.id===id);if(current?.state==='queued'){current.state='failed';current.error=redact(error.message);await this.receipt('request_failed',{job_id:id});await this.save();}});
      });
      this.executions.set(id,execution);this.projectQueues.set(lane,execution);
      void execution.finally(()=>{this.executions.delete(id);if(this.projectQueues.get(lane)===execution)this.projectQueues.delete(lane);}).catch(()=>{});
    }
    if(execution){if(wait||job.kind==='write')await execution;else await Promise.race([execution,new Promise(resolve=>setTimeout(resolve,200))]);}
    return this.getJob(id);
  }
  async submit(kind,input,{wait=false}={}){
    const prepared=await this.prepare(kind,input);
    if(prepared.state==='queued')return this.schedule(prepared.id,{wait});
    return this.getJob(prepared.id);
  }
  async approve(id){
    const prepared=await this.serial(async()=>{
      this.checkAccess();const job=this.jobs.find(j=>j.id===id);if(!job)throw Error('Job not found.');
      if(job.state!=='pending')return this.publicJob(job);
      if(this.accessMode==='read_only')throw Error('Read only mode blocks this action.');
      if(this.accessMode==='files_only'&&EXECUTION_KINDS.has(job.kind))throw Error('Files only mode blocks commands, tests, project tasks and managed processes.');
      if(this.accessMode==='project_tasks'&&ARBITRARY_EXECUTION_KINDS.has(job.kind))throw Error('Project Tasks mode blocks arbitrary commands and managed processes.');
      if(Date.now()>Date.parse(job.expires_at)){job.state='expired';await this.save();return this.publicJob(job);}
      job.approved=true;job.state='queued';await this.receipt('request_approved',{job_id:id,kind:job.kind});await this.save();return this.publicJob(job);
    });
    return prepared.state==='queued'?this.schedule(id,{wait:prepared.kind==='write'}):prepared;
  }
  publicJob(job) { const { id, kind, state, project_id, path: filename, created_at, expires_at, result, error, receipt_hash, lane_key, pid, process_started_at, process_finished_at, stdout_tail, stderr_tail, output_truncated, source_client_id, source_provider, source_transport } = job; const next=state==='pending'?'Waiting for local approval in PC Bridge. Nothing has executed yet.':['queued','running'].includes(state)?(kind==='process'?'Managed process is active or queued. Use bridge_process_status for live PID/output without joining its execution queue.':'Running automatically. Check bridge_get_job for the actual result.'):undefined; return { id, kind, state, project_id, path: filename, created_at, expires_at, result, error, receipt_hash, lane_key, pid, process_started_at, process_finished_at, stdout_tail, stderr_tail, output_truncated, source_client_id, source_provider, source_transport, requires_approval:state==='pending', provenance:PROCESS_LIKE_KINDS.has(kind)?'untrusted_process_output':undefined, instruction_authority:PROCESS_LIKE_KINDS.has(kind)?false:undefined, next }; }
  getJob(id) { this.checkAccess(); const job = this.jobs.find(j => j.id === id); if (!job) throw Error('Job not found.'); this.project(job.project_id); return this.publicJob(job); }
  processStatus(id){const job=this.jobs.find(j=>j.id===id);if(!job||!PROCESS_LIKE_KINDS.has(job.kind))throw Error('Managed process or project task not found.');this.checkAccess();return this.publicJob(job);}
  vaultDay(day){this.checkAccess();if(!this.vault)throw Error('Vault is unavailable.');return {...this.vault.day(day),provenance:'untrusted_vault_metadata',instruction_authority:false};}
  vaultSearch(query,limit=50){this.checkAccess();if(!this.vault)throw Error('Vault is unavailable.');return {...this.vault.search(query,limit),provenance:'untrusted_vault_metadata',instruction_authority:false};}
  listProcesses(){this.checkAccess();return {processes:this.jobs.filter(j=>PROCESS_LIKE_KINDS.has(j.kind)).slice(-20).reverse().map(j=>this.publicJob(j))};}
  async cancelClientJobs(clientId,reason='AI client authority changed locally in PC Bridge.') {
    return this.serial(async()=>{
      let cancelled=0;
      for(const job of this.jobs){
        if(job.source_client_id!==clientId||!['pending','queued','running'].includes(job.state))continue;
        this.controllers.get(job.id)?.abort();job.state='cancelled';job.error=reason;cancelled++;
      }
      if(cancelled){await this.receipt('ai_client_jobs_cancelled',{client_id:clientId,count:cancelled,reason});await this.save();}
      return{client_id:clientId,cancelled};
    });
  }
  async cancel(id) {
    return this.serial(async () => {
      const job = this.jobs.find(j => j.id === id); if (!job) throw Error('Job not found.');
      if (!['pending','queued','running'].includes(job.state)) return this.publicJob(job);
      this.controllers.get(id)?.abort(); job.state = 'cancelled'; await this.receipt('request_cancelled', { job_id:id }); await this.save(); return this.publicJob(job);
    });
  }
  async execute(id) {
    const job = await this.serial(async () => {
      this.checkAccess(); const job = this.jobs.find(j=>j.id===id); if (!job || job.state !== 'queued') throw Error('Request is no longer waiting to execute.');
      if(MUTATING_KINDS.has(job.kind) && this.accessMode==='read_only')throw Error('Read only mode blocks this action.');
      if(EXECUTION_KINDS.has(job.kind) && this.accessMode==='files_only')throw Error('Files only mode blocks commands, tests, project tasks and managed processes.');
      if(ARBITRARY_EXECUTION_KINDS.has(job.kind) && this.accessMode==='project_tasks')throw Error('Project Tasks mode blocks arbitrary commands and managed processes.');
      if(MUTATING_KINDS.has(job.kind) && this.accessMode==='approve_changes' && job.approved!==true){job.state='pending';await this.save();throw Error('Local approval is required before execution.');}
      if(Date.now() > Date.parse(job.expires_at)) {job.state='expired'; await this.save(); throw Error('Request expired. Ask the connected AI to submit a new request.');}
      const project=this.project(job.project_id);
      if(this.jobs.some(j=>j.id!==job.id && (j.lane_key??j.project_id)===(job.lane_key??job.project_id) && j.state==='running')) throw Error('Another job is running in this execution lane.');
      if(job.kind==='test' && (project.task!==job.task || await this.fingerprint(project.id)!==job.fingerprint)) throw Error('Project changed since the test request. Submit a fresh request.');
      if(job.kind==='test'&&this.accessMode==='project_tasks'){const grant=project.task_grant;const taskSha=(await this.read(project.id,job.task)).sha256;if(!grant||grant.path!==job.task||grant.sha256!==taskSha||grant.project_fingerprint!==job.fingerprint)throw Error('The saved test is no longer covered by its local Project Tasks grant.');}
      if(job.kind==='project_task'){const grant=(project.project_tasks||[]).find(t=>t.id===job.task_id);const taskSha=grant?(await this.read(project.id,grant.path)).sha256:null;const fingerprint=grant?await this.fingerprint(project.id):null;if(!grant||grant.path!==job.task||grant.sha256!==job.task_sha256||taskSha!==job.task_sha256||fingerprint!==job.grant_fingerprint||grant.project_fingerprint!==job.grant_fingerprint)throw Error('Project task grant changed or became stale before execution. Nothing was run.');}
      if(job.kind==='write') {
        let current=null; try{current=(await this.read(project.id,job.path)).sha256;}catch(error){if(error.code!=='ENOENT')throw error;}
        if(current!==job.before_sha256)throw Error('File changed since the proposal. Nothing was overwritten.');
      }
      job.state='running'; await this.receipt('execution_started', {job_id:id,input_sha256:job.signature}); await this.save(); return job;
    });
    try {
      const project=this.project(job.project_id);
      if(job.kind==='write') {
        await this.serial(async()=>{
          this.checkAccess(); if(job.state!=='running')throw Error('Request was cancelled.'); const target=await this.safePath(project.id,job.path,true);
          if(job.before!==null) await writeFile(path.join(this.dataDir,'backups',job.id+'.txt'),job.before,{flag:'wx',mode:0o600});
          if(job.before===null) await writeFile(target,job.content,{flag:'wx'});
          else {
            if((await this.read(project.id,job.path)).sha256!==job.before_sha256)throw Error('File changed before saving.');
            const handle=await open(target,'r+');
            try{const info=await handle.stat();if(info.nlink!==1 || digest(await handle.readFile('utf8'))!==job.before_sha256)throw Error('File changed before saving.'); await handle.write(Buffer.from(job.content),0,Buffer.byteLength(job.content),0); await handle.truncate(Buffer.byteLength(job.content)); await handle.sync();}finally{await handle.close();}
          }
          job.result={path:job.path,sha256:(await this.read(project.id,job.path)).sha256,backup_available:job.before!==null};
        });
      } else {
        this.checkAccess(); if(job.state!=='running')throw Error('Request was cancelled.');
        const controller=new AbortController();this.controllers.set(id,controller);
        const leaseTimer=this.trustedAccess ? null : setTimeout(()=>controller.abort(),Math.max(1,this.leaseUntil-Date.now()));
        try {
          if(job.kind==='command') job.result=await this.commandRunner({ ...job, nodeExecutable:this.nodeExecutable, electronNode:this.electronNode, signal:controller.signal });
          else if(job.kind==='process') job.result=await this.processRunner({ ...job, nodeExecutable:this.nodeExecutable, electronNode:this.electronNode, signal:controller.signal, onStart:info=>{job.pid=info.pid;job.process_started_at=info.started_at;this.emit('change');}, onOutput:info=>{job.stdout_tail=info.stdout_tail;job.stderr_tail=info.stderr_tail;job.output_truncated=info.output_truncated;this.emit('change');} });
          else if(job.kind==='project_task') job.result=await this.taskRunner({root:project.root,task:job.task,max_runtime_seconds:job.max_runtime_seconds,nodeExecutable:this.nodeExecutable,electronNode:this.electronNode,signal:controller.signal,onStart:info=>{job.pid=info.pid;job.process_started_at=info.started_at;this.emit('change');},onOutput:info=>{job.stdout_tail=info.stdout_tail;job.stderr_tail=info.stderr_tail;job.output_truncated=info.output_truncated;this.emit('change');}});
          else job.result=await this.runner({root:project.root,task:job.task,nodeExecutable:this.nodeExecutable,electronNode:this.electronNode,signal:controller.signal});
        }
        finally {clearTimeout(leaseTimer);this.controllers.delete(id);}
      }
      await this.serial(async()=>{if(PROCESS_LIKE_KINDS.has(job.kind))job.process_finished_at=now();if(job.state!=='cancelled')job.state=job.kind!=='write' && (job.result.exit_code!==0 || job.result.stopped)?'failed':'succeeded';job.receipt_hash=await this.receipt('request_finished',{job_id:id,state:job.state,result_sha256:digest(JSON.stringify(job.result))});await this.save();});
    } catch(error) {await this.serial(async()=>{if(job.state!=='cancelled')job.state='failed';job.error=redact(error.message);job.receipt_hash=await this.receipt('request_failed',{job_id:id});await this.save();});}
    return this.publicJob(job);
  }
  async restore(id) {
    return this.serial(async()=>{
      this.checkAccess(); const job=this.jobs.find(j=>j.id===id);if(!job || job.kind!=='write' || job.state!=='succeeded' || job.before===null || job.restored)throw Error('No restorable edit selected.');
      if(this.jobs.some(j=>j.project_id===job.project_id && j.state==='running'))throw Error('Wait for the running job before restoring.');
      if((await this.read(job.project_id,job.path)).sha256!==job.after_sha256)throw Error('File changed after this edit. Automatic restore is refused.');
      const backup=await readFile(path.join(this.dataDir,'backups',id+'.txt'),'utf8');if(digest(backup)!==job.before_sha256)throw Error('Backup integrity check failed.');
      const target=await this.safePath(job.project_id,job.path); const handle=await open(target,'r+');
      try {const info=await handle.stat();if(info.nlink!==1 || digest(await handle.readFile('utf8'))!==job.after_sha256)throw Error('File changed before restore.');await handle.write(Buffer.from(backup),0,Buffer.byteLength(backup),0);await handle.truncate(Buffer.byteLength(backup));await handle.sync();}finally{await handle.close();}
      job.restored=true;await this.receipt('local_restore',{job_id:id,sha256:job.before_sha256});await this.save();
    });
  }
  async demo() {
    const root=path.join(this.dataDir,'Practice project'); await mkdir(root,{recursive:true}); await mkdir(path.join(root,'tests'),{recursive:true});
    const seed={
      'README.md':'# Practice project\nAsk ChatGPT to read the files, fix the failing addition test, then run the tests. The current PC Bridge access mode controls whether changes run directly, are blocked, or wait for local approval.\n',
      'calculator.mjs':'export function add(a, b) {\n  return a - b; // Deliberate practice bug\n}\n',
      'tests/calculator.test.mjs':'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../calculator.mjs";\ntest("adds positive numbers", () => assert.equal(add(2, 3), 5));\ntest("adds zero", () => assert.equal(add(8, 0), 8));\n'
    };
    for(const [name,content] of Object.entries(seed)){try{await writeFile(path.join(root,name),content,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}}
    const existing=this.projects.find(p=>p.root===root);return existing ?? this.addProject(root,'Practice project','tests/calculator.test.mjs');
  }
}

export function runNodeTests({root,task,nodeExecutable,electronNode,signal}) {
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)));
    if(electronNode)env.ELECTRON_RUN_AS_NODE='1';
    const child=spawn(nodeExecutable,['--test','--test-isolation=none',task],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='',total=0,stopped=null;
    const stop=reason=>{if(stopped)return;stopped=reason;if(process.platform==='win32' && child.pid){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGKILL');};
    const abort=()=>stop('Cancelled or access expired.'); signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timeout=setTimeout(()=>stop('Test exceeded the 30-second limit.'),30000);
    const collect=kind=>chunk=>{total+=chunk.length;if(total>65536){stop('Test exceeded the output limit.');return;}if(kind==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
    child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
    const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);};
    child.on('error',error=>{cleanup();reject(error);});child.on('close',code=>{cleanup();resolve({exit_code:code,stdout:redact(stdout),stderr:redact(stderr),stopped,execution:'Bundled Node.js test runner; runs with your Windows user privileges, NOT an OS sandbox.',provenance:'untrusted_test_output',instruction_authority:false});});
  });
}
