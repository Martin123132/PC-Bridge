import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {summarizeUiJob} from '../src/ui-state.mjs';

const source=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const job={id:'example-job',kind:'write',state:'succeeded',path:'example.txt',project_name:'Example',created_at:'2026-01-01T12:00:00Z',content:'Submitted <text>',before:'Previous text',result:{output:'Full result'},command:'example command',stderr_tail:'error output',stdout_tail:'last output',receipt_hash:'example-hash'};
function snapshot(){return {jobs:[summarizeUiJob(job)],projects:[],checkpoints:[],receipts:1,connection:{ready:false,state:'stopped'},ai_clients:{clients:[]},access_mode:'read_only',access_enabled:false};}
async function renderer(call=async command=>command==='state'?snapshot():job){
  const elements=new Map();
  for(const id of ['main','activity-rail','connection-pill','access-label','build-badge','pause-top','sync-chat','review','review-content','toast']){
    const listeners=new Map();let html='';
    elements.set('#'+id,{writes:0,open:false,classList:{toggle(){}},addEventListener:(type,fn)=>listeners.set(type,fn),
      get innerHTML(){return html;},set innerHTML(value){html=value;this.writes++;},
      replaceChildren(){this.innerHTML='';},showModal(){this.open=true;},close(){this.open=false;listeners.get('close')?.();}});
  }
  const context=vm.createContext({document:{activeElement:null,querySelector:s=>elements.get(s)||null,querySelectorAll:()=>[],addEventListener(){}},
    window:{bridge:{call,onChange(){}}},setTimeout:()=>1,clearTimeout(){},Intl,Date});
  const ui=await vm.runInContext(`(async()=>{${source}\nreturn {review,refreshFromBridge,time,setPage(page){current=page;render();},setState(next){state=next;render();}};})()`,context);
  return {ui,elements};
}

test('large receipt bodies stay in history while every summary and rail preview survives',()=>{
  const jobs=Array.from({length:1000},(_,i)=>({...job,id:'job-'+i,content:'x'.repeat(10000),before:'y'.repeat(10000)}));
  const original=JSON.stringify(jobs),summaries=jobs.map(summarizeUiJob);
  assert.equal(JSON.stringify(jobs),original);
  assert.deepEqual(summaries.map(j=>j.id),jobs.map(j=>j.id));
  assert.equal(summaries[0].stdout_tail,job.stdout_tail);
  for(const field of ['content','before','result','command','stderr_tail'])assert.equal(field in summaries[0],false);
  assert.ok(JSON.stringify(summaries).length<original.length/20);
});

test('idle updates retain the Activity DOM; real changes and navigation still render',async()=>{
  const {ui,elements}=await renderer(),main=elements.get('#main');
  ui.setPage('activity');const writes=main.writes;
  for(let i=0;i<10;i++)ui.setState({...snapshot(),connection:{ready:true,state:'ready',detail:String(i)}});
  assert.equal(main.writes,writes);
  assert.equal((main.innerHTML.match(/class="job-row"/g)||[]).length,1);
  const changed=snapshot();changed.jobs[0].state='pending';ui.setState(changed);
  assert.equal(main.writes,writes+1);assert.match(main.innerHTML,/waiting for your approval/);
  for(const page of ['home','chat','connect','remote','projects','calendar','activity']){
    ui.setPage(page);assert.match(main.innerHTML,/<h1>/);
  }
});

test('receipts load full contents on demand and closing releases them',async()=>{
  const commands=[];const {ui,elements}=await renderer(async(command,data)=>{commands.push([command,data]);return command==='state'?snapshot():job;});
  assert.equal(commands.some(([command])=>command==='jobDetail'),false);
  await ui.review(job.id);const content=elements.get('#review-content');
  assert.match(content.innerHTML,/Submitted &lt;text&gt;/);assert.match(content.innerHTML,/Previous text/);assert.match(content.innerHTML,/Full result/);
  assert.deepEqual(JSON.parse(JSON.stringify(commands.at(-1))),['jobDetail',{id:job.id}]);
  elements.get('#review').close();assert.equal(content.innerHTML,'');
});

test('late receipt responses cannot replace a newer receipt or reopen a closed dialog',async()=>{
  const requests=[];const {ui,elements}=await renderer(async command=>{if(command==='state')return snapshot();const d=deferred();requests.push(d);return d.promise;});
  const first=ui.review('old'),second=ui.review('new');
  requests[1].resolve({...job,content:'New receipt'});await second;
  requests[0].resolve({...job,content:'Old receipt'});await first;
  assert.match(elements.get('#review-content').innerHTML,/New receipt/);
  const last=ui.review('late');elements.get('#review').close();requests[2].resolve(job);await last;
  assert.equal(elements.get('#review').open,false);assert.equal(elements.get('#review-content').innerHTML,'');
});

test('refresh bursts are serialized and coalesced, including recovery after failure',async()=>{
  let boot=true,active=0,maxActive=0;const pending=[];
  const {ui}=await renderer(async command=>{
    if(command!=='state')return job;if(boot){boot=false;return snapshot();}
    active++;maxActive=Math.max(maxActive,active);const d=deferred();pending.push(d);
    try{return await d.promise;}finally{active--;}
  });
  const calls=Array.from({length:20},()=>ui.refreshFromBridge());
  assert.equal(pending.length,1);pending[0].resolve(snapshot());await tick();
  assert.equal(pending.length,2);pending[1].resolve(snapshot());await Promise.all(calls);assert.equal(maxActive,1);
  const failed=ui.refreshFromBridge();pending[2].reject(Error('Unavailable'));await assert.rejects(failed,/Unavailable/);
  const recovered=ui.refreshFromBridge();pending[3].resolve(snapshot());await recovered;assert.equal(maxActive,1);
});

test('cached time formatter keeps the existing timestamp display',async()=>{
  const {ui}=await renderer();
  for(const value of [null,'invalid','2026-03-29T01:30:00Z','2026-10-25T01:30:00Z']){
    const expected=value?new Date(value).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'Not yet';
    assert.equal(ui.time(value),expected);
  }
});

test('preload exposes receipt lookup through the existing IPC channel only',async()=>{
  const preload=await readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8');let bridge;const invoked=[];
  vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld:(_,api)=>bridge=api},ipcRenderer:{invoke:(...args)=>{invoked.push(args);return Promise.resolve(job);}}})});
  assert.equal(await bridge.call('jobDetail',{id:job.id}),job);
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)),[['pc-bridge','jobDetail',{id:job.id}]]);
  await assert.rejects(bridge.call('arbitrary-command'),/Unsupported action/);
});
