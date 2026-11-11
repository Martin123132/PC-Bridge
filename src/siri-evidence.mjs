// Siri evidence providers. These read local, user-owned task data only.
// No arbitrary paths arrive from the network; the evidence folder is chosen
// through the local PC Bridge desktop file chooser, never from a Siri request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const clean = value => String(value ?? '').replace(/[\r\n\t<>*_\x60]/g,' ').replace(/\s+/g,' ').trim().slice(0,90);
const bounded = (file,max=200_000) => {
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>max)throw Error('Evidence file is missing or too large.');
  return fs.readFileSync(file,'utf8');
};
const nameMap = root => {
  const names=new Map(),file=path.join(root,'session_index.jsonl');
  try {
    for(const line of bounded(file,2_000_000).split(/\r?\n/)) {
      if(!line)continue;
      try {
        const item=JSON.parse(line);
        if(typeof item.id==='string'&&/^[0-9a-f-]{36}$/.test(item.id)&&typeof item.thread_name==='string')
          names.set(item.id,clean(item.thread_name));
      }catch{}
    }
  }catch{}
  return names;
};

export function inspectCodexTasks({codexRoot=path.join(os.homedir(),'.codex'),now=Date.now()}={}) {
  const historyFile=path.join(codexRoot,'thread_history_1.sqlite');
  const stateFile=path.join(codexRoot,'state_5.sqlite');
  if(!fs.existsSync(historyFile)||!fs.existsSync(stateFile))return {
    tasks:[],message:'Codex task history is not available on this Windows account.'
  };
  let history,threads;
  try {
    history=new DatabaseSync(historyFile,{readOnly:true,timeout:1200});
    threads=new DatabaseSync(stateFile,{readOnly:true,timeout:1200});
    const threshold=Math.floor(now/1000)-90*60;
    const recent=history.prepare("SELECT thread_id,started_at FROM thread_turns WHERE status='inProgress' AND started_at >= ? ORDER BY started_at DESC LIMIT 5").all(threshold);
    const titles=nameMap(codexRoot);
    const meta=threads.prepare('SELECT title FROM threads WHERE id=?');
    const activity=history.prepare("SELECT substr(item_json,1,2000) AS value FROM thread_items WHERE thread_id=? AND item_type='reasoning' ORDER BY rollout_ordinal DESC LIMIT 6");
    const tasks=recent.map(row=>{
      let label=titles.get(row.thread_id)||clean(meta.get(row.thread_id)?.title);
      if(!label){
        for(const item of activity.all(row.thread_id)) {
          try{
            const data=JSON.parse(item.value||'{}');
            label=Array.isArray(data.summary)?clean(data.summary.join(' ')):'';
            if(label)break;
          }catch{}
        }
      }
      return {title:label||'Unnamed Codex task',started_at:row.started_at};
    });
    const summary=tasks.length?
      'Codex has '+tasks.length+' task turn'+(tasks.length===1?'':'s')+' recorded as in progress within the past 90 minutes. Latest: '+tasks[0].title+'.':
      'Codex has no task turns recorded as in progress within the past 90 minutes.';
    return {tasks,message:summary+' This is recorded task status, not a live execution-speed measurement.'};
  } finally {
    try{history?.close();}catch{}
    try{threads?.close();}catch{}
  }
}

export function inspectBuildEvidence({folder}={}) {
  if(!folder)return {ready:false,resultsFolder:null,message:'No build evidence folder is configured. Choose one in PC Bridge Connect Siri.'};
  if(typeof folder!=='string'||!path.isAbsolute(folder))throw Error('Invalid locally chosen evidence folder.');
  const resultsFolder=path.join(folder,'output-attempt3');
  const receipt=path.join(folder,'delivery-receipt.json');
  const runtime=path.join(folder,'runtime-tests-verified.exit');
  const source=path.join(folder,'source-tests-rerun.exit');
  if(![receipt,runtime,source].every(fs.existsSync))return {
    ready:false,resultsFolder:fs.existsSync(resultsFolder)?resultsFolder:null,
    message:'The selected build folder does not contain the three required saved verification records.'
  };
  const item=JSON.parse(bounded(receipt));
  const runtimeExit=bounded(runtime,32).trim();
  const sourceExit=bounded(source,32).trim();
  const binary=path.join(resultsFolder,'bin','ffmpeg.exe');
  const binaryExists=fs.existsSync(binary)&&fs.statSync(binary).isFile()&&fs.statSync(binary).size>0;
  const ready=runtimeExit==='0'&&sourceExit==='0'&&binaryExists;
  const installed=item.installed===true?'installed':item.installed===false?'not installed':'installation status not recorded';
  const merged=item.merged===true?'merged':item.merged===false?'not merged':'merge status not recorded';
  const message='Accessibility FFmpeg build: '+(ready?'saved source and verified runtime checks passed':'saved verification is incomplete or failed')+
    '. The FFmpeg executable '+(binaryExists?'exists':'is missing')+'. Delivery says '+installed+' and '+merged+'.';
  return {ready,resultsFolder:fs.existsSync(resultsFolder)?resultsFolder:null,message};
}
