import tunnelPackage from '@maxoperf/tunnel';

const { runTunnelClient } = tunnelPackage;
const AUTO_RESUME_REASONS=new Set(['idle','ttl']);

export class PublicTunnel {
  constructor({onChange,onGuestIdentity,runClient=runTunnelClient,fetchImpl=fetch}){
    this.onChange=onChange;this.onGuestIdentity=onGuestIdentity;this.runClient=runClient;this.fetchImpl=fetchImpl;
    this.client=null;this.child=null;this.timer=null;this.resumeTimer=null;this.generation=0;this.identitySave=Promise.resolve();
    this.state='stopped';this.ready=false;this.reachable=false;this.checkBusy=false;
    this.detail='Persistent endpoint is stopped.';this.baseUrl=null;this.mcpUrl=null;
    this.secret=null;this.provider='maxoperf-guest-tunnel';this.port=null;this.guestToken=null;this.lastCloseReason=null;
  }
  snapshot(){return{state:this.state,ready:this.ready,reachable:this.reachable,detail:this.detail,mcp_url:this.mcpUrl,temporary:false,persistent:true,provider:this.provider};}

  async start({port,secret,guestToken=null}){
    if(this.client||this.resumeTimer)throw Error('Stop the existing persistent endpoint before starting another.');
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Remote MCP port is invalid.');
    if(!/^[0-9a-f]{64}$/.test(secret||''))throw Error('Remote MCP capability secret is invalid.');
    if(guestToken!=null&&typeof guestToken!=='string')throw Error('Saved endpoint identity is invalid.');
    this.secret=secret;this.port=port;this.baseUrl=null;this.mcpUrl=null;this.guestToken=guestToken||null;this.lastCloseReason=null;
    this.state='connecting';this.ready=false;this.reachable=false;this.checkBusy=false;
    this.detail=guestToken?'Restoring this installation\'s persistent HTTPS endpoint…':'Creating this installation\'s persistent HTTPS endpoint…';
    const generation=++this.generation;
    clearInterval(this.timer);
    this.timer=setInterval(()=>void this.check(),2500);this.timer.unref?.();
    this.onChange();
    try{this.launchClient(generation);}
    catch(error){clearInterval(this.timer);this.timer=null;this.state='error';this.detail='Persistent endpoint helper could not start.';this.onChange();throw error;}
    return this.snapshot();
  }

  launchClient(generation){
    if(generation!==this.generation||this.state==='stopped')return;
    if(!this.guestToken&&this.baseUrl){this.state='error';this.detail='Saved persistent endpoint identity is missing.';this.onChange();return;}
    const onEvent=event=>{
      if(generation!==this.generation)return;
      if(event?.type==='guest'){
        if(event.guestToken){
          this.guestToken=event.guestToken;
          this.identitySave=Promise.resolve(this.onGuestIdentity?.({guestToken:event.guestToken,url:event.url,tunnelId:event.tunnelId}))
            .catch(error=>{if(generation!==this.generation)return;this.state='error';this.ready=false;this.reachable=false;this.detail='PC Bridge could not save the persistent endpoint identity.';this.onChange();throw error;});
        }
        if(event.url&&!this.baseUrl){this.baseUrl=String(event.url).replace(/\/$/,'');this.mcpUrl=this.baseUrl+'/mcp/'+this.secret;}
        this.onChange();return;
      }
      if(event?.type==='online'){
        const nextBase=String(event.url||'').replace(/\/$/,'');
        if(this.baseUrl&&nextBase&&nextBase!==this.baseUrl){
          this.ready=false;this.reachable=false;this.state='error';this.detail='Persistent endpoint address changed unexpectedly. The saved Claude connector was not changed.';this.onChange();
          void this.client?.close?.();return;
        }
        this.baseUrl=nextBase||this.baseUrl;
        this.mcpUrl=this.baseUrl?this.baseUrl+'/mcp/'+this.secret:null;
        this.state='connecting';this.detail=event.reconnected?'Persistent endpoint reconnected. Verifying MCP reachability…':'Persistent endpoint online. Verifying MCP reachability…';
        this.onChange();void this.check();return;
      }
      if(event?.type==='reconnecting'){
        this.ready=false;this.reachable=false;this.state='connecting';this.detail='Persistent endpoint interrupted. Reconnecting to the same address…';this.onChange();return;
      }
      if(event?.type==='local-error'){
        this.ready=false;this.reachable=false;this.state='connecting';this.detail='Persistent endpoint cannot reach the local MCP listener yet.';this.onChange();return;
      }
      if(event?.type==='closed'&&this.state!=='stopped'){
        this.lastCloseReason=String(event.reason||'');
        this.ready=false;this.reachable=false;
        if(AUTO_RESUME_REASONS.has(this.lastCloseReason)){
          this.state='connecting';this.detail='Persistent endpoint idled. Reconnecting to the same saved address…';this.onChange();return;
        }
        this.state=event.exitCode===0?'stopped':'error';this.detail=event.message||'Persistent endpoint stopped.';
        clearInterval(this.timer);this.timer=null;this.onChange();
      }
    };

    this.lastCloseReason=null;
    const client=this.runClient({port:this.port,host:'127.0.0.1',server:'app.maxoperf.com:443',guestToken:this.guestToken||undefined,onEvent});
    this.client=client;this.child=client;
    client.done?.then(code=>{
      if(generation!==this.generation)return;
      if(this.client===client){this.client=null;this.child=null;}
      const reason=this.lastCloseReason;this.lastCloseReason=null;
      if(AUTO_RESUME_REASONS.has(reason)&&this.state!=='stopped'){
        if(!this.guestToken){this.state='error';this.detail='Persistent endpoint idled but its saved identity is unavailable.';clearInterval(this.timer);this.timer=null;this.onChange();return;}
        this.ready=false;this.reachable=false;this.state='connecting';this.detail='Persistent endpoint idled. Reconnecting to the same saved address…';this.onChange();
        clearTimeout(this.resumeTimer);
        this.resumeTimer=setTimeout(()=>{this.resumeTimer=null;if(generation===this.generation&&this.state!=='stopped'&&this.state!=='error')this.launchClient(generation);},500);
        this.resumeTimer.unref?.();
        return;
      }
      if(this.state==='stopped'||this.state==='error')return;
      clearInterval(this.timer);this.timer=null;this.ready=false;this.reachable=false;
      this.state=code===0?'stopped':'error';this.detail=code===0?'Persistent endpoint stopped.':'Persistent endpoint helper stopped.';this.onChange();
    }).catch(()=>{
      if(generation!==this.generation)return;
      if(this.client===client){this.client=null;this.child=null;}
      this.ready=false;this.reachable=false;this.state='error';this.detail='Persistent endpoint helper failed.';clearInterval(this.timer);this.timer=null;this.onChange();
    });
  }

  async check(){
    if(!this.client||!this.baseUrl||!this.secret)return;
    if(this.checkBusy)return;
    this.checkBusy=true;
    try{
      await this.identitySave;
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);timeout.unref?.();
      let response;
      try{response=await this.fetchImpl(this.baseUrl+'/healthz/'+this.secret,{method:'GET',headers:{accept:'application/json'},redirect:'follow',signal:controller.signal});}
      finally{clearTimeout(timeout);}
      let body=null;try{body=await response.json();}catch{}
      if(response.ok&&body?.ok===true&&body?.transport==='remote-mcp'){
        this.ready=true;this.reachable=true;this.state='connected';this.detail='Persistent Claude MCP endpoint is publicly reachable.';
      }else{
        this.ready=false;this.reachable=false;this.state='connecting';this.detail='Persistent HTTPS address is online. Waiting for the local MCP route to become reachable…';
      }
    }catch{
      if(this.state!=='error'){this.ready=false;this.reachable=false;this.state='connecting';this.detail='Persistent HTTPS address is online but the MCP route is not reachable yet.';}
    }finally{this.checkBusy=false;this.onChange();}
  }

  async stop(){
    const generation=++this.generation;
    clearInterval(this.timer);this.timer=null;clearTimeout(this.resumeTimer);this.resumeTimer=null;
    const client=this.client;this.client=null;this.child=null;
    this.state='stopped';this.ready=false;this.reachable=false;this.checkBusy=false;
    this.detail='Persistent endpoint is stopped.';this.baseUrl=null;this.mcpUrl=null;this.secret=null;this.port=null;this.guestToken=null;this.lastCloseReason=null;this.identitySave=Promise.resolve();
    this.onChange();
    if(client){try{await client.close();}catch{}}
    return generation;
  }
}
