import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../src/core.mjs';

export class Tunnel {
  constructor({binary,dataDir,onChange}){this.binary=binary;this.dataDir=dataDir;this.onChange=onChange;this.child=null;this.state='stopped';this.ready=false;this.detail='Not connected yet.';this.healthFile=null;}
  snapshot(){return{state:this.state,ready:this.ready,detail:this.detail};}
  async start({tunnelId,key,port,localToken}){
    if(this.child)throw Error('Stop the existing connection before starting another.');
    if(!/^tunnel_[0-9a-f]{32}$/.test(tunnelId))throw Error('Enter the tunnel ID from OpenAI Platform.');
    if(!/^sk-[A-Za-z0-9_-]{20,}$/.test(key))throw Error('Enter a valid tunnel runtime key.');
    this.healthFile=path.join(this.dataDir,`tunnel-health-${randomUUID()}.url`);
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(k)));
    env.CONTROL_PLANE_API_KEY=key;env.PC_BRIDGE_MCP_AUTH=`Bearer ${localToken}`;
    const args=['run','--control-plane.tunnel-id',tunnelId,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--mcp.server-url',`http://127.0.0.1:${port}/mcp`,'--mcp.extra-headers','Authorization: env:PC_BRIDGE_MCP_AUTH','--health.listen-addr','127.0.0.1:0','--health.url-file',this.healthFile,'--log.format','json','--log.level','info'];
    this.state='connecting';this.detail='Opening an outbound secure connection…';this.ready=false;
    const child=spawn(this.binary,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});this.child=child;
    // No raw tunnel output is stored or exposed. Only a safe diagnostic category is shown.
    const diagnostic=buffer=>{const line=buffer.toString();if(/401|invalid.*key|authentication failed/i.test(line))this.detail='The runtime key was rejected or expired. Replace it in Connect.';else if(/403|forbidden/i.test(line))this.detail='Check Tunnels Read + Use and the tunnel workspace association.';else if(/poll.*fail|network|timeout/i.test(line))this.detail='Connection interrupted. The tunnel is trying to reconnect.';this.onChange();};
    child.stdout.on('data',diagnostic);child.stderr.on('data',diagnostic);
    child.on('error',error=>{clearInterval(this.timer);this.state='error';this.detail=error.code==='ENOENT'?'The bundled connection helper is missing. Repair or reinstall PC Bridge.':redact('Connection helper could not start.');this.ready=false;this.child=null;this.onChange();});
    child.on('close',()=>{if(this.child!==child)return;clearInterval(this.timer);this.child=null;this.ready=false;if(this.state!=='stopped'){this.state='error';if(!/key|Read/.test(this.detail))this.detail='Connection helper stopped. Check your setup and try again.';}this.onChange();});
    this.timer=setInterval(()=>void this.check(),2500);this.onChange();
  }
  async check(){
    const active=this.child;if(!active)return;
    try {
      const base=(await readFile(this.healthFile,'utf8')).trim().replace(/\/healthz$/,'');
      if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))return;
      const response=await fetch(base+'/readyz',{signal:AbortSignal.timeout(1800)});
      if(this.child!==active)return;
      this.ready=response.ok;this.state=response.ok?'connected':'connecting';if(response.ok)this.detail='Secure tunnel ready. Waiting for ChatGPT requests.';
    }catch{if(this.child!==active)return;this.ready=false;this.state='connecting';}
    this.onChange();
  }
  async stop(){clearInterval(this.timer);this.state='stopped';this.ready=false;this.detail='Connection stopped.';const child=this.child;this.child=null;if(child){await new Promise(resolve=>{child.once('close',resolve);child.kill();setTimeout(resolve,2500).unref();});}this.onChange();}
}
