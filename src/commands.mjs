import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// The allowlist prevents the bridge's tunnel credentials and Node injection
// options leaking into children. It is not a sandbox: children are the user.
export function commandEnvironment(electronNode = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|COMSPEC|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  if (electronNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function invocation(shell, command, nodeExecutable, electronNode) {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const executable = shell === 'node' ? nodeExecutable : shell === 'cmd' ? path.join(system, 'cmd.exe') : path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // EncodedCommand preserves exact Unicode text. It does not change execution policy.
  const args = shell === 'node' ? ['-e', command] : shell === 'cmd' ? ['/d', '/s', '/c', command] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("[Console]::OutputEncoding = [Text.UTF8Encoding]::new();\n" + command, 'utf16le').toString('base64')];
  return { system, executable, args, env: commandEnvironment(shell === 'node' && electronNode) };
}

function killTree(system, child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(path.join(system,'taskkill.exe'), ['/PID',String(child.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'});
    killer.on('error', () => child.kill()); killer.on('exit', code => { if (code) child.kill(); });
  } else child.kill('SIGKILL');
}

const redact = text => String(text).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED KEY]').replace(/(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi,'$1[REDACTED]');

export function runCommand({ shell, command, cwd, timeout_seconds = 60, nodeExecutable = process.execPath, electronNode = false, signal }) {
  const {system,executable,args,env}=invocation(shell,command,nodeExecutable,electronNode);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve({exit_code:null,stdout:'',stderr:'',stopped:'Cancelled before starting.',provenance:'untrusted_process_output',instruction_authority:false}); return; }
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'] });
    const decoders = {stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const output = {stdout:'',stderr:''}; let bytes = 0, stopped = null;
    const stop = reason => { if (stopped) return; stopped = reason; killTree(system,child); };
    const abort = () => stop('Cancelled by owner or access paused.');
    signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => stop(`Command exceeded the ${timeout_seconds}-second limit.`), timeout_seconds * 1000);
    for (const channel of ['stdout','stderr']) child[channel].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { stop('Command exceeded the 64 KiB output limit.'); return; }
      output[channel] += decoders[channel].write(chunk);
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); resolve({exit_code:code,stdout:redact(output.stdout+decoders.stdout.end()),stderr:redact(output.stderr+decoders.stderr.end()),stopped,execution:'Trusted command running as your Windows user; not an OS sandbox. Command edits do not receive automatic file-tool backups.',provenance:'untrusted_process_output',instruction_authority:false}); });
  });
}

export function runManagedCommand({ shell, command, cwd, max_runtime_seconds = 3600, nodeExecutable = process.execPath, electronNode = false, signal, onStart = () => {}, onOutput = () => {} }) {
  const {system,executable,args,env}=invocation(shell,command,nodeExecutable,electronNode);
  const TAIL_LIMIT=32768;
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){resolve({exit_code:null,stdout_tail:'',stderr_tail:'',stopped:'Cancelled before starting.',output_truncated:false,provenance:'untrusted_process_output',instruction_authority:false});return;}
    const child=spawn(executable,args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const tails={stdout:'',stderr:''};const dropped={stdout:0,stderr:0};let stopped=null;
    const publish=()=>onOutput({stdout_tail:redact(tails.stdout),stderr_tail:redact(tails.stderr),output_truncated:Boolean(dropped.stdout||dropped.stderr),dropped_bytes:{...dropped}});
    const append=(channel,text)=>{
      tails[channel]+=text;
      if(Buffer.byteLength(tails[channel],'utf8')>TAIL_LIMIT){
        const buf=Buffer.from(tails[channel],'utf8');const excess=buf.length-TAIL_LIMIT;dropped[channel]+=excess;tails[channel]=buf.subarray(excess).toString('utf8');
      }
      publish();
    };
    const stop=reason=>{if(stopped)return;stopped=reason;killTree(system,child);};
    const abort=()=>stop('Cancelled by owner or access paused.');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop(`Managed process exceeded the ${max_runtime_seconds}-second runtime limit.`),max_runtime_seconds*1000);
    onStart({pid:child.pid,started_at:new Date().toISOString()});
    child.stdout.on('data',chunk=>append('stdout',decoders.stdout.write(chunk)));
    child.stderr.on('data',chunk=>append('stderr',decoders.stderr.write(chunk)));
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.on('error',error=>{cleanup();reject(error);});
    child.on('close',code=>{
      append('stdout',decoders.stdout.end());append('stderr',decoders.stderr.end());cleanup();
      resolve({exit_code:code,stdout_tail:redact(tails.stdout),stderr_tail:redact(tails.stderr),stopped,output_truncated:Boolean(dropped.stdout||dropped.stderr),dropped_bytes:dropped,execution:'Managed process tracked by PC Bridge as your Windows user; not an OS sandbox.',provenance:'untrusted_process_output',instruction_authority:false});
    });
  });
}

export function runManagedNodeTask({ root, task, max_runtime_seconds = 3600, nodeExecutable = process.execPath, electronNode = false, signal, onStart = () => {}, onOutput = () => {} }) {
  const system=path.join(process.env.SystemRoot||'C:\\Windows','System32');const env=commandEnvironment(electronNode);
  const TAIL_LIMIT=32768;
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){resolve({exit_code:null,stdout_tail:'',stderr_tail:'',stopped:'Cancelled before starting.',output_truncated:false,provenance:'untrusted_process_output',instruction_authority:false});return;}
    const child=spawn(nodeExecutable,[task],{cwd:root,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};const tails={stdout:'',stderr:''};const dropped={stdout:0,stderr:0};let stopped=null;
    const publish=()=>onOutput({stdout_tail:redact(tails.stdout),stderr_tail:redact(tails.stderr),output_truncated:Boolean(dropped.stdout||dropped.stderr),dropped_bytes:{...dropped}});
    const append=(channel,text)=>{tails[channel]+=text;if(Buffer.byteLength(tails[channel],'utf8')>TAIL_LIMIT){const buf=Buffer.from(tails[channel],'utf8');const excess=buf.length-TAIL_LIMIT;dropped[channel]+=excess;tails[channel]=buf.subarray(excess).toString('utf8');}publish();};
    const stop=reason=>{if(stopped)return;stopped=reason;killTree(system,child);};const abort=()=>stop('Cancelled by owner or access paused.');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop(`Project task exceeded the ${max_runtime_seconds}-second runtime limit.`),max_runtime_seconds*1000);onStart({pid:child.pid,started_at:new Date().toISOString()});
    child.stdout.on('data',chunk=>append('stdout',decoders.stdout.write(chunk)));child.stderr.on('data',chunk=>append('stderr',decoders.stderr.write(chunk)));
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};child.on('error',error=>{cleanup();reject(error);});child.on('close',code=>{append('stdout',decoders.stdout.end());append('stderr',decoders.stderr.end());cleanup();resolve({exit_code:code,stdout_tail:redact(tails.stdout),stderr_tail:redact(tails.stderr),stopped,output_truncated:Boolean(dropped.stdout||dropped.stderr),dropped_bytes:dropped,execution:'Locally pinned project task tracked by PC Bridge as your Windows user; not an OS sandbox.',provenance:'untrusted_process_output',instruction_authority:false});});
  });
}
