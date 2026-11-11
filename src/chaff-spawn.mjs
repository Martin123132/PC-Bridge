// A ChildProcess-shaped adapter for the four Bridge task runners only.
// Legacy pinned builds remain readable; new builds resolve installer registration.
import {spawn as nativeSpawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {resolveRuntime} from './bridge_runtime.mjs';
const BINDING = /*CHAFF_BINDING*/ null;

function verify(file, hash) {
  if(!path.isAbsolute(file))throw Error('Chaff requires an absolute runtime path');
  for(let p=file;;p=path.dirname(p)){
    if(fs.lstatSync(p).isSymbolicLink())throw Error('Chaff runtime link refused');
    if(path.dirname(p)===p)break;
  }
  if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('Chaff runtime changed; task not launched');
}

export function spawnContained(executable,args,options) {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.pid=undefined;child.exitCode=null;child.boundary='windows_lifetime_job';
  let supervisor, cancelled=false, escalation, finished=false;
  child.kill=()=>{
    cancelled=true;
    if(supervisor && !supervisor.stdin.destroyed)supervisor.stdin.end('stop\n');
    if(supervisor&&!escalation)escalation=setTimeout(()=>supervisor.kill(),6000);
    return true;
  };
  queueMicrotask(()=>{
    try{
      if(process.platform!=='win32')throw Error('Windows lifetime supervisor unavailable; task not launched');
      const binding=BINDING||resolveRuntime();
      if(options.shell || !Array.isArray(args))throw Error('Unsupported contained launch');
      for(const file of Object.values(binding.files))verify(file.path,file.sha256);
      supervisor=nativeSpawn(binding.files.python.path,['-I','-S','-B',binding.files.helper.path],{
        cwd:path.dirname(binding.files.helper.path), windowsHide:true,shell:false,
        env:options.env,stdio:['pipe','pipe','pipe']
      });
      child.supervisorPid=supervisor.pid;
      let buffer='',terminal=null, failure=null;
      const bad=()=>{failure=new Error('Chaff lifetime supervisor failed; no uncontained fallback');child.kill();};
      supervisor.stdin.on('error',bad);
      supervisor.stdout.on('data',chunk=>{
        buffer+=chunk.toString('utf8');
        if(buffer.length>131072){bad();return;}
        let index;
        while((index=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
          try{
            const r=JSON.parse(line);
            if(r.type==='started'&&!child.pid&&Number.isSafeInteger(r.pid)&&r.pid>0){
              child.pid=r.pid;child.emit('spawn');
            }else if(r.type==='output'&&!terminal&&['stdout','stderr'].includes(r.channel)&&typeof r.data==='string'&&r.data.length<=5500){
              child[r.channel].write(Buffer.from(r.data,'base64'));
            }else if(r.type==='exit'&&!terminal&&r.active===0&&Number.isInteger(r.code))terminal=r;
            else bad();
          }catch{bad();}
        }
      });
      // Never mix supervisor diagnostics into task output or expose launch input.
      supervisor.stderr.on('data',()=>{failure=new Error('Chaff supervisor diagnostic failure');});
      supervisor.on('error',error=>{failure=error;});
      supervisor.on('close',code=>{
        clearTimeout(escalation);finished=true;
        child.stdout.end();child.stderr.end();
        if(code!==0||!terminal||buffer||failure){
          child.emit('error',failure||new Error('Chaff supervisor ended without an empty-family receipt'));
          child.emit('close',70);return;
        }
        child.exitCode=terminal.code;child.containment=terminal;
        child.emit('close',terminal.code);
      });
      supervisor.stdin.write(JSON.stringify({executable,args,cwd:options.cwd,env:options.env})+'\n');
      if(cancelled)child.kill();
    }catch(error){
      if(supervisor&&!finished)supervisor.kill();
      child.stdout.end();child.stderr.end();child.emit('error',error);child.emit('close',70);
    }
  });
  return child;
}
