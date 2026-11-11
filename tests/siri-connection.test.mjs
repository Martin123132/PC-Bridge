import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSiriController, selectSiriAddress } from '../src/siri-connection.mjs';
import { makeClientPolicy } from '../src/client-policy.mjs';
import { ClientRegistry } from '../src/client-registry.mjs';

const mkDir=()=>mkdtemp(path.join(os.tmpdir(), 'pcbridge-siri-'));
function coreStub(){
  const receipts=[];
  return {
    accessMode:'full',trustedAccess:true,receipts,events:[],
    checkAccess(){if(!this.trustedAccess)throw Error('Paused');},
    serial:fn=>Promise.resolve().then(fn),
    async receipt(type, detail){receipts.push({type,...detail});},
    emit(name){this.events.push(name);},
  };
}
const secretHeaders=token=>({ 'x-siri-key':token, 'Content-Type':'application/json' });
async function request(address,token,action){
  return fetch(address,{method:'POST',headers:secretHeaders(token),body:JSON.stringify({action})});
}
async function fixture(t){
  const dataDir=await mkDir();
  const core=coreStub(),state={ceiling:'read_only',musicRunning:false,musicWindowVisible:true,failMusic:false,musicLaunchCount:0},launches=[],launchArgs=[];
  const clients={siriPolicy:()=>makeClientPolicy({id:'siri-shortcuts',provider:'apple-siri',transport:'local-shortcuts',maxAccessMode:state.ceiling})};
  const controller=createSiriController({
    core,clients,dataDir,port:0,allowLoopbackForTests:true,minIntervalMs:0,addressResolver:()=> '127.0.0.1',
    encrypt:text=>Buffer.from(text.split('').reverse().join(''),'utf8'),
    decrypt:buf=>String(buf).split('').reverse().join(''),
    appLauncher:async (program,args=[])=>{launches.push(program);launchArgs.push(args);},
    fileExists:()=>true,
    musicActivator:async()=>{state.musicLaunchCount++;if(!state.failMusic)state.musicRunning=true;},
    musicProcessPolls:3,musicProcessPollDelayMs:1,
    musicWindowVisible:async()=>state.musicWindowVisible,musicStableDelayMs:1,
    codexReader:()=>({message:'Codex task currently recorded as in progress: verifying the demo.'}),
    evidenceReader:({folder})=>({message:folder?'Saved build checks passed.':'No evidence folder configured.',resultsFolder:folder?path.join(folder,'output-attempt3'):null}),
    isRunning:image=>image==='AppleMusic.exe'&&state.musicRunning,
  });
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,core,state,launches,launchArgs,dataDir};
}

test('Siri connection: interface selection prefers Wi-Fi and skips virtual NICs',()=>{
  assert.equal(selectSiriAddress({
    'vEthernet (WSL)':[{family:'IPv4',internal:false,address:'192.168.20.2'}],
    Ethernet:[{family:'IPv4',internal:false,address:'10.0.0.2'}],
    'WiFi 2':[{family:'IPv4',internal:false,address:'192.168.50.123'}],
  }),'192.168.50.123');
  assert.throws(()=>selectSiriAddress({'WiFi':[{family:'IPv4',internal:false,address:'8.8.8.8'}]}),/private/);
});

test('Siri controller starts only when called; persists encrypted local pairing',async t=>{
  const {controller,core,dataDir}=await fixture(t);
  assert.equal(controller.snapshot().ready,false);
  const started=await controller.start();
  assert.equal(started.ready,true);
  assert.equal(started.host,'127.0.0.1');
  assert.ok(started.port>0);
  assert.ok(started.address.endsWith('/v1/action'));
  assert.equal(controller.snapshot().token,undefined);
  const pairing=await controller.pairing();
  assert.match(pairing.token,/^[a-f0-9]{64}$/);
  const encrypted=await readFile(path.join(dataDir,'siri-shortcuts.encrypted'),'utf8');
  assert.ok(!encrypted.includes(pairing.token),'storage contains encrypted, not plaintext key');
  assert.equal((await request(started.address,pairing.token,'status')).status,200);
  await controller.stop();
  assert.equal(controller.snapshot().ready,false);
  const reopened=await controller.start();
  assert.equal(reopened.ready,true);
  assert.equal((await controller.pairing()).token,pairing.token,'same pairing after stop/start');
  assert.ok(core.receipts.some(x=>x.type==='siri_shortcuts_started'));
});

test('Siri controller: read-only ceiling denies app launches, local Full allows only fixed apps',async t=>{
  const {controller,core,state,launches}=await fixture(t);
  await controller.start();
  const {address,token}=await controller.pairing();
  assert.equal((await request(address,token,'open_notepad')).status,403);
  assert.equal(launches.length,0);
  state.ceiling='full';
  const r=await request(address,token,'open_notepad');
  assert.equal(r.status,200);
  assert.match(await r.text(),/Notepad/);
  assert.equal(launches.length,1);
  assert.match(launches[0],/notepad.exe$/i);
  const unknown=await request(address,token,'run_shell');
  assert.equal(unknown.status,400);
  assert.equal(launches.length,1);
  core.accessMode='approve_changes';
  assert.equal((await request(address,token,'open_notepad')).status,403,'approval mode never silently executes actions');
  assert.equal(launches.length,1);
  core.accessMode='read_only';
  assert.equal((await request(address,token,'status')).status,200,'read-only still reports status');
  assert.ok(core.receipts.some(x=>x.type==='siri_shortcuts_action' && x.tool==='open_notepad' && x.outcome==='ok'));
});

test('Siri controller: global Pause and pairing revocation both block old access',async t=>{
  const {controller,core,state}=await fixture(t);
  state.ceiling='full';
  await controller.start();
  const first=await controller.pairing();
  core.trustedAccess=false;
  assert.equal((await request(first.address,first.token,'status')).status,403);
  assert.equal((await request(first.address,first.token,'open_explorer')).status,403);
  core.trustedAccess=true;
  assert.equal((await request(first.address,'f'.repeat(64),'status')).status,401);
  await controller.rotate();
  assert.equal(controller.snapshot().ready,false);
  await controller.start();
  const second=await controller.pairing();
  assert.notEqual(second.token,first.token);
  assert.equal((await request(second.address,first.token,'status')).status,401);
  assert.equal((await request(second.address,second.token,'status')).status,200);
  assert.ok(core.receipts.some(x=>x.type==='siri_shortcuts_pairing_revoked'));
});

test('Siri client is local-only and independent of Claude remote MCP selection',async t=>{
  const dataDir=await mkDir();
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const events=[],core={
    serial:fn=>Promise.resolve().then(fn),
    async receipt(type,detail){events.push({type,...detail});},
    emit(){},
    async cancelClientJobs(){},
  };
  const registry=await new ClientRegistry({dataDir,core}).init();
  const builtIn=registry.snapshot().clients.find(x=>x.client_id==='siri-shortcuts');
  assert.ok(builtIn?.built_in);
  assert.equal(builtIn.transport,'local-shortcuts');
  assert.equal(registry.siriPolicy().max_access_mode,'read_only');
  assert.equal(registry.activeRemoteRecord(),null);
  const remote=await registry.create({label:'Claude',provider:'anthropic-claude',max_access_mode:'read_only'});
  assert.equal(registry.activeRemoteRecord().id,remote.id);
  await registry.setCeiling(builtIn.id,'full');
  assert.equal(registry.siriPolicy().max_access_mode,'full');
  assert.equal(registry.activeRemoteRecord().id,remote.id);
  const reloaded=await new ClientRegistry({dataDir,core}).init();
  assert.equal(reloaded.siriPolicy().transport,'local-shortcuts');
  assert.equal(reloaded.siriPolicy().max_access_mode,'full');
  assert.equal(reloaded.activeRemoteRecord().id,remote.id);
});

test('Siri controller reads Codex tasks and build receipts; opening results needs local Full access',async t=>{
  const {controller,core,state,launches,launchArgs,dataDir}=await fixture(t);
  await controller.start();
  const {address,token}=await controller.pairing();
  const codex=await request(address,token,'codex_tasks');
  assert.equal(codex.status,200);
  assert.match(await codex.text(),/verifying the demo/);
  const before=await request(address,token,'accessibility_build');
  assert.equal(before.status,200);
  assert.match(await before.text(),/No evidence folder configured/);
  assert.equal((await request(address,token,'review_accessibility_build')).status,403);
  assert.equal(launches.length,0);
  await controller.setEvidenceFolder(dataDir);
  assert.equal(controller.snapshot().evidence_folder,dataDir);
  const after=await request(address,token,'accessibility_build');
  assert.equal(after.status,200);
  assert.match(await after.text(),/Saved build checks passed/);
  state.ceiling='full';
  const open=await request(address,token,'review_accessibility_build');
  assert.equal(open.status,200);
  assert.match(await open.text(),/Opened the saved results folder/);
  assert.equal(launches.length,1);
  assert.match(launches[0],/explorer\.exe$/i);
  assert.deepEqual(launchArgs[0],[path.join(dataDir,'output-attempt3')]);
  core.trustedAccess=false;
  assert.equal((await request(address,token,'codex_tasks')).status,403);
  assert.equal((await request(address,token,'review_accessibility_build')).status,403);
  assert.equal(launches.length,1);
  assert.ok(core.receipts.some(x=>x.type==='siri_evidence_folder_selected'));
});

test('Siri virtual phone launches installed Music and searches Google using URL-encoded spoken input',async t=>{
  const {controller,state,launches,launchArgs}=await fixture(t);
  await controller.start();
  const {address,token}=await controller.pairing();
  assert.equal((await request(address,token,'open_apple_music')).status,403);
  assert.equal(launches.length,0);
  assert.equal((await request(address,token,'search_google')).status,400,'search requires a query');
  state.ceiling='full';
  const music=await request(address,token,'open_apple_music');
  assert.equal(music.status,200);
  assert.match(await music.text(),/Apple Music window is open/);
  assert.equal(state.musicLaunchCount,1);
  assert.equal(launches.length,0);
  const google=await request(address,token,'open_google');
  assert.equal(google.status,200);
  assert.match(await google.text(),/Opened Google/);
  assert.match(launches[0],/msedge\.exe$/i);
  assert.deepEqual(launchArgs[0],['https://www.google.com/']);
  const search=await fetch(address,{method:'POST',headers:secretHeaders(token),body:JSON.stringify({request:'Search Google for NGC 3198 rotation curve'})});
  assert.equal(search.status,200);
  assert.match(await search.text(),/NGC 3198 rotation curve/);
  const url=new URL(launchArgs[1][0]);
  assert.equal(url.origin,'https://www.google.com');
  assert.equal(url.pathname,'/search');
  assert.equal(url.searchParams.get('q'),'NGC 3198 rotation curve');
  assert.equal(launchArgs.length,2);
  const local=await controller.performLocally({action:'search_google',query:'how does motion relate to time'});
  assert.match(local.message,/how does motion relate to time/);
  assert.equal(new URL(launchArgs[2][0]).searchParams.get('q'),'how does motion relate to time');
});

test('Siri does not report Apple Music success when its Windows process never appears',async t=>{
  const {controller,core,state,launches}=await fixture(t);
  state.ceiling='full';
  state.failMusic=true;
  await controller.start();
  const {address,token}=await controller.pairing();
  const reply=await request(address,token,'open_apple_music');
  assert.equal(reply.status,500);
  assert.equal(state.musicLaunchCount,1);
  assert.equal(launches.length,0);
  assert.ok(core.receipts.some(x=>x.type==='siri_shortcuts_action'&&x.tool==='open_apple_music'&&x.outcome==='failed'));
});

test('Siri rejects a brief AppleMusic.exe process without a visible app window',async t=>{
  const {controller,core,state,launches}=await fixture(t);
  state.ceiling='full';
  state.musicWindowVisible=false;
  await controller.start();
  const {address,token}=await controller.pairing();
  const reply=await request(address,token,'open_apple_music');
  assert.equal(reply.status,500);
  assert.equal(state.musicLaunchCount,1);
  assert.equal(state.musicRunning,true,'transient process alone cannot constitute success');
  assert.equal(launches.length,0);
  assert.ok(core.receipts.some(x=>x.type==='siri_shortcuts_action'&&x.tool==='open_apple_music'&&x.outcome==='failed'));
  assert.equal(core.receipts.some(x=>x.type==='siri_shortcuts_action'&&x.tool==='open_apple_music'&&x.outcome==='ok'),false);
});
