import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicTunnel } from '../desktop/public-tunnel.mjs';

const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function fakeClient({url='https://stable-install.example',guestToken='guest-install-token',reconnected=false,capture,onLaunch}={}){
  return opts=>{
    capture?.(opts);
    onLaunch?.(opts);
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    queueMicrotask(()=>{
      opts.onEvent?.({type:'guest',url,tunnelId:'guest-1',guestToken});
      opts.onEvent?.({type:'online',url,tunnelId:'guest-1',guest:true,reconnected});
    });
    return {done,close:async()=>finish(0)};
  };
}

test('persistent endpoint reuses installation identity and full MCP URL',async()=>{
  const secret='a'.repeat(64),base='https://stable-install.example';
  const fetchImpl=async url=>({ok:url===base+'/healthz/'+secret,json:async()=>({ok:true,transport:'remote-mcp'})});
  let saved=null,firstOpts=null,secondOpts=null;

  const first=new PublicTunnel({
    onChange:()=>{},
    onGuestIdentity:async x=>{saved=x.guestToken;},
    runClient:fakeClient({url:base,capture:o=>{firstOpts=o;}}),
    fetchImpl
  });
  await first.start({port:12001,secret});
  await tick(30);
  await first.check();
  const firstUrl=first.snapshot().mcp_url;
  assert.equal(firstOpts.guestToken,undefined);
  assert.equal(saved,'guest-install-token');
  assert.equal(first.snapshot().ready,true);
  await first.stop();

  const second=new PublicTunnel({
    onChange:()=>{},
    onGuestIdentity:async()=>{},
    runClient:fakeClient({url:base,reconnected:true,capture:o=>{secondOpts=o;}}),
    fetchImpl
  });
  await second.start({port:23002,secret,guestToken:saved});
  await tick(30);
  await second.check();
  assert.equal(secondOpts.guestToken,'guest-install-token');
  assert.equal(second.snapshot().mcp_url,firstUrl);
  assert.equal(second.snapshot().persistent,true);
  assert.equal(second.snapshot().ready,true);
  await second.stop();
});

test('idle closure resumes the same saved endpoint identity',async()=>{
  const secret='b'.repeat(64),base='https://stable-install.example';
  let launches=0,saved=null,secondOpts=null;

  const runClient=opts=>{
    launches++;
    if(launches===2)secondOpts=opts;
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    queueMicrotask(()=>{
      if(launches===1){
        opts.onEvent({type:'guest',url:base,tunnelId:'guest-1',guestToken:'guest-install-token'});
        opts.onEvent({type:'online',url:base,tunnelId:'guest-1',guest:true,reconnected:false});
        setTimeout(()=>{
          opts.onEvent({type:'closed',reason:'idle',exitCode:0,message:'idle'});
          finish(0);
        },20);
      }else{
        opts.onEvent({type:'guest',url:base,tunnelId:'guest-1'});
        opts.onEvent({type:'online',url:base,tunnelId:'guest-1',guest:true,reconnected:true});
      }
    });
    return {done,close:async()=>finish(0)};
  };

  const fetchImpl=async()=>({ok:true,json:async()=>({ok:true,transport:'remote-mcp'})});
  const tunnel=new PublicTunnel({
    onChange:()=>{},
    onGuestIdentity:async x=>{saved=x.guestToken||saved;},
    runClient,
    fetchImpl
  });
  await tunnel.start({port:12004,secret});
  for(let i=0;i<30&&launches<2;i++)await tick(50);
  assert.equal(launches,2);
  assert.equal(saved,'guest-install-token');
  assert.equal(secondOpts.guestToken,'guest-install-token');
  for(let i=0;i<20&&!tunnel.snapshot().ready;i++){await tunnel.check();await tick(20);}
  assert.equal(tunnel.snapshot().mcp_url,base+'/mcp/'+secret);
  assert.equal(tunnel.snapshot().ready,true);
  await tunnel.stop();
});
