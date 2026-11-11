// Owner-latched remote gate. No agent request can start, stop or leave this mode.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {resolveRuntime} from './bridge_runtime.mjs';
const BINDING = /*CHAFF_VM_BINDING*/ null;
const sha = b=>createHash('sha256').update(b).digest('hex');
const active = j=>['pending','queued','running'].includes(j.state);
const TOOLS = new Set(['bridge_protected_status','bridge_protected_shell','bridge_protected_review']);
// Cold integrity checking and image preparation precede the worker's own
// 90-second boot deadline. Software mode needs a bounded allowance for both.
// This is selected locally, never supplied by an agent or tool argument.
export const startupBudgetMs = binding => binding?.accelerator==='tcg' ? 300000 : 180000;

export class VmRelay {
  constructor(binding, output, onExit, selection=null) {
    binding=binding||resolveRuntime();
    for(const {path:file,sha256} of Object.values(binding.files)) {
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||sha(fs.readFileSync(file))!==sha256)throw Error('Protected runtime identity mismatch');
    }
    this.pending=new Map();this.next=0;this.closed=false;this.exited=false;this.total=0;this.buffer='';
    const args=['-E','-s','-B',binding.files.relay.path,'--out',output];
    if(binding.accelerator)args.push('--accel',binding.accelerator);
    if(selection)args.push('--selection',selection.path,'--selection-sha256',selection.sha256);
    const child=this.child=spawn(binding.files.python.path,args,
      {windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:path.dirname(binding.files.relay.path)});
    child.stdin.on('error',()=>{});
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.finished=new Promise(resolve=>{this.finishResolve=resolve;});
    this.deadline=setTimeout(()=>this.stop(),startupBudgetMs(binding));this.deadline.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      try {
        this.total+=Buffer.byteLength(chunk);this.buffer+=chunk;
        if(this.total>4*1024*1024||Buffer.byteLength(this.buffer)>524288)throw Error('VM transport budget');
        let end;
        while((end=this.buffer.indexOf('\n'))>=0){
          const row=JSON.parse(this.buffer.slice(0,end));this.buffer=this.buffer.slice(end+1);
          if(row.event==='ready') {clearTimeout(this.deadline);this.deadline=setTimeout(()=>this.stop(),930000);this.deadline.unref();this.readyResolve(row.status);continue;}
          const pending=this.pending.get(row.id);if(!pending)throw Error('Unknown VM response');
          this.pending.delete(row.id);clearTimeout(pending.timer);
          if(row.ok===true)pending.resolve(row.data);else pending.reject(Error('Protected operation refused or failed.'));
        }
      }catch{this.stop();}
    });
    let errors=0;
    const errorLog=fs.openSync(output+'.stderr.txt','wx',0o600);
    child.stderr.on('data',chunk=>{if(errors<65536)fs.writeSync(errorLog,chunk.subarray(0,65536-errors));errors+=chunk.length;if(errors>65536)this.stop();});
    child.once('error',()=>this.stop());
    child.once('close',()=>{
      this.closed=true;this.exited=true;clearTimeout(this.deadline);clearTimeout(this.killTimer);
      fs.closeSync(errorLog);
      this.readyReject(Error('Protected VM unavailable; host routes remain locked.'));
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Protected VM stopped.'));}
      this.pending.clear();onExit();this.finishResolve();
    });
  }
  call(name,arguments_,timeoutMs=30000) {
    if(this.closed||this.pending.size)throw Error('Protected VM is stopped or busy.');
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.stop();},timeoutMs);timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,name,arguments:arguments_})+'\n');
    });
  }
  stop() {
    if(!this.closed){this.closed=true;this.child.stdin.end();this.killTimer=setTimeout(()=>{if(!this.exited)this.child.kill();},5000);this.killTimer.unref();}
    return this.finished;
  }
}

export class ProtectedBridge {
  constructor({core,dataDir,binding=BINDING,relayFactory=(...args)=>new VmRelay(...args)}) {
    this.core=core;this.binding=binding;this.relayFactory=relayFactory;this.relay=null;this.starting=null;
    this.activeCalls=0;this.busy=false;this.state='ordinary';this.detail='Ordinary Bridge mode. No VM is running.';
    this.selection=null;this.output=null;this.checkResult=null;this.checking=false;this.reviewCount=0;
    this.latch=path.join(dataDir,'chaff-protected-only.json');this.outputBase=path.join(dataDir,'chaff-protected-runs');
    for(let p=path.resolve(dataDir);;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('Linked protected directory refused');if(path.dirname(p)===p)break;}
    // Any existing record, even malformed, holds the gate. Never fail open on startup.
    this.latched=fs.existsSync(this.latch);
    if(this.latched){this.state='held';this.detail='Protected-only lock restored. VM not running; host routes remain blocked.';}
    this.rawAccess=core.checkAccess.bind(core);
    core.checkAccess=()=>{if(this.latched)throw Error('Chaff protected-only mode blocks host access.');return this.rawAccess();};
    const enable=core.enable?.bind(core);
    if(enable)core.enable=(...args)=>{if(this.latched)throw Error('Leave protected-only mode locally in Chaff first.');return enable(...args);};
    const pause=core.pause.bind(core);
    core.pause=async(...args)=>{const stopping=this.stop();await pause(...args);await stopping;};
  }
  notifyDisplay() {queueMicrotask(()=>{try{this.core.emit?.('change');}catch{/* Display observers cannot alter containment. */}});}
  status() {return {version:1,protected_only:this.latched,state:this.state,message:this.detail,host_routes_blocked:this.latched,
    scope:'This PC Bridge connection only; other connectors and local applications are outside this boundary.',
    task:this.selection?.task||'Included example: fix /project/app.py slug to trim and collapse whitespace; run python3 -m unittest. Review export never applies changes.',
    project:this.selection?.name||'Included example',selection_identity:this.selection?.sha256||null,
    review_files:this.selection?.review_names||['app.py'],test_files:this.selection?.test_names||['test_app.py'],
    guest_network:false,shared_host_folders:false};}
  ownerStatus(){return {...this.status(),output_directory:this.output,check_result:this.checkResult,
    checking:this.checking,review_count:this.reviewCount,return_access_mode:this.core.accessMode};}
  select(selectionPath,expected){
    if(this.latched||this.relay||this.checking||this.busy)throw Error('Leave protected mode before selecting a project');
    if(selectionPath===null&&expected===null){this.selection=null;return this.ownerStatus();}
    if(typeof selectionPath!=='string'||!path.isAbsolute(selectionPath)||typeof expected!=='string'||!/^[0-9a-f]{64}$/.test(expected))throw Error('Invalid owner selection');
    for(let p=path.resolve(selectionPath);;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('Linked selection refused');if(path.dirname(p)===p)break;}
    const stat=fs.lstatSync(selectionPath);
    if(!stat.isFile()||stat.nlink!==1||stat.size>131072)throw Error('Invalid selection file');
    const bytes=fs.readFileSync(selectionPath);if(sha(bytes)!==expected)throw Error('Selection changed');
    const value=JSON.parse(bytes);
    if(value.version!==1||typeof value.repository!=='string'||typeof value.task!=='string'||value.task.length>2000||
       !Array.isArray(value.review_names)||!Array.isArray(value.test_names)||
       ![value.review_names,value.test_names].every(v=>v.length>=1&&v.length<=8&&v.every(n=>typeof n==='string'&&n.length<=200)))throw Error('Invalid selection shape');
    this.selection={path:selectionPath,sha256:expected,name:path.basename(value.repository),task:value.task,
      review_names:value.review_names,test_names:value.test_names};
    return this.ownerStatus();
  }
  async dispatch(name,input,operation) {
    this.activeCalls++;
    try {
      if(name==='bridge_protected_status'||(name==='bridge_status'&&this.latched))return this.status();
      if(this.latched&&!TOOLS.has(name))throw Error('Protected-only mode: host files, shell, Git, Vault and job history are blocked. Use bridge_protected_status/shell/review.');
      if(!TOOLS.has(name))return await operation(input);
      if(!this.latched||this.state!=='protected'||!this.relay||this.checking)throw Error('No available protected work VM. The owner starts work locally in Chaff.');
      if(this.core.accessMode!=='full')throw Error('Protected commands require the owner’s existing Full access mode and client ceiling.');
      if(name==='bridge_protected_shell'){
        if(!input||Object.keys(input).sort().join()!=='command,seconds'||typeof input.command!=='string'||Buffer.byteLength(input.command)>8192||!Number.isInteger(input.seconds)||input.seconds<1||input.seconds>10)throw Error('Invalid bounded guest command');
        return await this.relay.call('vm_shell',input);
      }
      if(Object.keys(input).length)throw Error('No review arguments allowed');
      const result=await this.relay.call('review_patch',{});this.reviewCount=result.review_number;return result;
    }finally{this.activeCalls--;}
  }
  start() {
    if(this.busy||this.relay||this.activeCalls||this.core.jobs.some(active)||this.core.controllers.size||this.core.executions.size)throw Error('Wait until Bridge work is idle before starting protected-only mode.');
    // Explicit local Start authorizes only the VM. Ordinary access may stay paused.
    if(this.core.accessMode!=='full')throw Error('Select Full access mode locally before starting the protected example. Ordinary access may remain paused.');
    if(this.selection&&sha(fs.readFileSync(this.selection.path))!==this.selection.sha256)throw Error('Selection changed; preview again');
    this.checkResult=null;this.reviewCount=0;
    this.latched=true;this.state='starting';this.detail='Starting protected copy. All host routes are blocked.';
    this.notifyDisplay();
    // Commit the restart latch before creating any worker; no async admission gap.
    try {
      if(!fs.existsSync(this.latch)){const fd=fs.openSync(this.latch,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({version:1,protected_only:true}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      const s=fs.lstatSync(this.latch);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('Invalid lock record');
      fs.mkdirSync(this.outputBase,{recursive:true});if(fs.lstatSync(this.outputBase).isSymbolicLink())throw Error('Linked output refused');
      this.output=path.join(this.outputBase,randomUUID());
      const relay=this.relay=this.relayFactory(this.binding,this.output,()=>{
        if(this.relay===relay){this.relay=null;this.state='held';this.detail='VM stopped. Host routes remain blocked until you leave protected-only mode.';this.notifyDisplay();}
      },this.selection);
      this.starting=relay.ready.then(()=>{if(this.relay===relay&&!relay.closed){this.state='protected';this.detail='Protected VM running: approved copy only, no network, no shared host folders.';}}).catch(()=>{this.state='held';this.detail='VM could not start. Host routes remain blocked; use Return to ordinary Bridge to leave.';}).finally(()=>this.notifyDisplay());
    }catch(error){this.state='held';this.detail='Protected startup failed; host routes remain blocked.';this.notifyDisplay();throw error;}
    return this.status();
  }
  async stop() {
    const relay=this.relay;
    if(relay){this.state='stopping';this.detail='Stopping the protected VM; host routes remain blocked.';this.notifyDisplay();await relay.stop();}
    if(this.latched){this.state='held';this.detail='VM stopped. Host routes remain blocked.';}
    this.notifyDisplay();
    return this.status();
  }
  check(){
    if(this.checking||this.activeCalls||!this.relay||this.state!=='protected'||!this.reviewCount||this.checkResult)throw Error('Save a review first and wait for the current operation');
    this.checking=true;this.state='checking';this.detail='Checking exported source in a fresh isolated VM. Host access remains locked.';
    this.checkResult={status:'CHECKING'};
    this.notifyDisplay();
    this.checkPromise=this.relay.call('check_result',{},240000).then(result=>{this.checkResult=result;this.detail=`Result: ${result.status}. No changes applied. Return to ordinary Bridge when ready.`;})
      .catch(()=>{this.checkResult={status:'INCOMPLETE'};this.detail='Result check stopped or incomplete. No changes applied.';})
      .finally(()=>{this.checking=false;if(this.latched)this.state='held';this.notifyDisplay();});
    return this.ownerStatus();
  }
  async leave({resume=false}={}) {
    if(this.busy)throw Error('Owner transition already in progress');
    this.busy=true;
    try{
      await this.core.pause(); // Persist ordinary access OFF before releasing the latch.
      if(this.activeCalls)throw Error('A protected call is still closing; host lock retained.');
      if(fs.existsSync(this.latch)){const s=fs.lstatSync(this.latch);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('Invalid lock record');fs.unlinkSync(this.latch);}
      this.latched=false;this.state='ordinary';this.detail='Protected mode left. Ordinary Bridge is PAUSED; resume only in PC Bridge desktop.';
      if(resume){await this.core.enable(this.core.accessMode);this.detail='Ordinary Bridge restored with your locally confirmed access mode. No VM is running.';}
      return this.status();
    }finally{this.busy=false;this.notifyDisplay();}
  }
}

export function installProtectedBridge(core,dataDir) {
  const manager=new ProtectedBridge({core,dataDir});core.chaffProtected=manager;return manager;
}
