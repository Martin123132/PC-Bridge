import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {inspectCodexTasks,inspectBuildEvidence} from '../src/siri-evidence.mjs';

async function workspace(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'siri-evidence-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
test('reads recent Codex turn status from local databases without changing them',async t=>{
  const root=await workspace(t),now=Date.parse('2026-11-10T01:00:00Z'),timestamp=Math.floor(now/1000);
  const a=new DatabaseSync(path.join(root,'state_5.sqlite'));
  a.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT)');
  const addThread=a.prepare('INSERT INTO threads(id,title) VALUES (?,?)');
  const recentID='01234567-89ab-cdef-0123-456789abcdef';
  const olderID='01234567-89ab-cdef-0123-456789abcdea';
  addThread.run(recentID,'Fallback title');addThread.run(olderID,'Older title');a.close();
  const b=new DatabaseSync(path.join(root,'thread_history_1.sqlite'));
  b.exec('CREATE TABLE thread_turns(thread_id TEXT,status TEXT,started_at INTEGER)');
  b.exec('CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,rollout_ordinal INTEGER,item_json TEXT)');
  const add=b.prepare('INSERT INTO thread_turns(thread_id,status,started_at) VALUES (?,?,?)');
  add.run(recentID,'inProgress',timestamp-60);
  add.run(olderID,'inProgress',timestamp-7_000);
  b.close();
  await writeFile(path.join(root,'session_index.jsonl'),JSON.stringify({id:recentID,thread_name:'Building the demo'})+'\n');
  const result=inspectCodexTasks({codexRoot:root,now});
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].title,'Building the demo');
  assert.match(result.message,/recorded as in progress/);
  assert.match(result.message,/Building the demo/);
  assert.doesNotMatch(result.message,/Older title/);
});
test('Codex activity descriptions are short, readable and do not claim live progress',async t=>{
  const root=await workspace(t),now=Date.parse('2026-11-10T01:00:00Z'),timestamp=Math.floor(now/1000);
  const id='01234567-89ab-cdef-0123-456789abcdef';
  const a=new DatabaseSync(path.join(root,'state_5.sqlite'));
  a.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT)');
  a.prepare('INSERT INTO threads(id,title) VALUES (?,?)').run(id,'');
  a.close();
  const b=new DatabaseSync(path.join(root,'thread_history_1.sqlite'));
  b.exec('CREATE TABLE thread_turns(thread_id TEXT,status TEXT,started_at INTEGER)');
  b.exec('CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,rollout_ordinal INTEGER,item_json TEXT)');
  b.prepare('INSERT INTO thread_turns(thread_id,status,started_at) VALUES (?,?,?)').run(id,'inProgress',timestamp-120);
  b.prepare('INSERT INTO thread_items(thread_id,item_type,rollout_ordinal,item_json) VALUES (?,?,?,?)').run(id,'reasoning',1,JSON.stringify({summary:['**Checking verification receipts**']}));
  b.close();
  const result=inspectCodexTasks({codexRoot:root,now});
  assert.equal(result.tasks[0].title,'Checking verification receipts');
  assert.match(result.message,/not a live execution-speed measurement/);
});
test('absent Codex database produces an explicit availability message',async t=>{
  const root=await workspace(t);
  const result=inspectCodexTasks({codexRoot:root});
  assert.equal(result.tasks.length,0);
  assert.match(result.message,/not available/);
});
test('checks locally selected build receipts and fixed executable path',async t=>{
  const root=await workspace(t);
  await mkdir(path.join(root,'output-attempt3','bin'),{recursive:true});
  await writeFile(path.join(root,'output-attempt3','bin','ffmpeg.exe'),'MZ fake test data');
  await writeFile(path.join(root,'delivery-receipt.json'),JSON.stringify({installed:false,merged:false}));
  await writeFile(path.join(root,'runtime-tests-verified.exit'),'0\n');
  await writeFile(path.join(root,'source-tests-rerun.exit'),'0\n');
  const result=inspectBuildEvidence({folder:root});
  assert.equal(result.ready,true);
  assert.equal(result.resultsFolder,path.join(root,'output-attempt3'));
  assert.match(result.message,/source and verified runtime checks passed/);
  assert.match(result.message,/not installed/);
  assert.match(result.message,/not merged/);
  await writeFile(path.join(root,'source-tests-rerun.exit'),'1\n');
  const failed=inspectBuildEvidence({folder:root});
  assert.equal(failed.ready,false);
  assert.match(failed.message,/incomplete or failed/);
});
test('build status cannot infer success without a locally configured evidence folder',async t=>{
  const root=await workspace(t);
  assert.match(inspectBuildEvidence().message,/No build evidence folder/);
  const missing=inspectBuildEvidence({folder:root});
  assert.equal(missing.ready,false);
  assert.equal(missing.resultsFolder,null);
  assert.match(missing.message,/required saved verification records/);
});
