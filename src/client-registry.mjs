import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './core.mjs';
import { CLIENT_ACCESS_MODES, makeClientPolicy } from './client-policy.mjs';

const FILE_VERSION=1;
const BUILTIN_ID='chatgpt-openai-tunnel';
const modeRank=mode=>({read_only:0,files_only:1,project_tasks:2,full:3})[mode]??-1;
const validMode=mode=>{if(!CLIENT_ACCESS_MODES.includes(mode))throw Error('Choose Read only, Files only, Project Tasks, or Full access for this AI client.');return mode;};
const cleanLabel=value=>{const text=String(value||'').trim();if(!text||text.length>60||/[\x00-\x1f]/.test(text))throw Error('AI client name must be 1–60 normal characters.');return text;};
const cleanProvider=value=>{const text=String(value||'external').trim().toLowerCase();if(!/^[a-z0-9._:-]{1,40}$/.test(text))throw Error('AI provider identifier must use letters, digits, dots, dashes, underscores or colons.');return text;};
const publicRecord=r=>({id:r.id,client_id:r.client_id,label:r.label,provider:r.provider,transport:r.transport,max_access_mode:r.max_access_mode,built_in:Boolean(r.built_in),created_at:r.created_at,updated_at:r.updated_at});

export class ClientRegistry {
  constructor({dataDir,core}){this.dataDir=dataDir;this.core=core;this.file=path.join(dataDir,'ai-clients.json');this.clients=[];this.activeRemoteClientId=null;this.queue=Promise.resolve();}
  serial(fn){const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next;}
  builtin(){return this.clients.find(x=>x.id===BUILTIN_ID);}
  record(id){const item=this.clients.find(x=>x.id===id);if(!item)throw Error('AI client record not found.');return item;}
  async init(){
    let loaded=null;
    try{loaded=JSON.parse(await readFile(this.file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('AI client policy settings are damaged. Remote AI connections are disabled until the file is repaired.');}
    if(loaded){
      if(loaded.version!==FILE_VERSION||!Array.isArray(loaded.clients))throw Error('AI client policy settings are damaged. Remote AI connections are disabled until the file is repaired.');
      this.clients=loaded.clients.map(raw=>this.validateRecord(raw));
      this.activeRemoteClientId=loaded.active_remote_client_id??null;
      if(this.activeRemoteClientId!==null){const active=this.clients.find(x=>x.id===this.activeRemoteClientId);if(!active||active.transport!=='remote-mcp')throw Error('AI client policy settings are damaged. Remote AI connections are disabled until the file is repaired.');}
    }
    let builtin=this.builtin();
    if(!builtin){const now=new Date().toISOString();builtin={id:BUILTIN_ID,client_id:'openai-tunnel',label:'ChatGPT',provider:'openai',transport:'openai-tunnel',max_access_mode:'full',built_in:true,created_at:now,updated_at:now};this.clients.unshift(builtin);await this.save();}
    else if(builtin.client_id!=='openai-tunnel'||builtin.provider!=='openai'||builtin.transport!=='openai-tunnel'||!builtin.built_in)throw Error('Built-in ChatGPT client policy is damaged. Remote AI connections are disabled until the file is repaired.');
    return this;
  }
  validateRecord(raw){
    if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||!raw.id||raw.id.length>80)throw Error('Invalid AI client record.');
    const transport=raw.transport==='openai-tunnel'?'openai-tunnel':raw.transport==='remote-mcp'?'remote-mcp':null;if(!transport)throw Error('Invalid AI client transport.');
    const clientId=String(raw.client_id||'');if(!/^[A-Za-z0-9._:-]{1,80}$/.test(clientId))throw Error('Invalid AI client identity.');
    return {id:raw.id,client_id:clientId,label:cleanLabel(raw.label),provider:cleanProvider(raw.provider),transport,max_access_mode:validMode(raw.max_access_mode),built_in:Boolean(raw.built_in),created_at:String(raw.created_at||new Date().toISOString()),updated_at:String(raw.updated_at||raw.created_at||new Date().toISOString())};
  }
  async save(){await atomicJson(this.file,{version:FILE_VERSION,active_remote_client_id:this.activeRemoteClientId,clients:this.clients});}
  snapshot(){return{version:FILE_VERSION,active_remote_client_id:this.activeRemoteClientId,clients:this.clients.map(publicRecord)};}
  policy(id){const r=this.record(id);return makeClientPolicy({id:r.client_id,provider:r.provider,transport:r.transport,maxAccessMode:r.max_access_mode});}
  chatgptPolicy(){return this.policy(BUILTIN_ID);}
  activeRemoteRecord(){return this.activeRemoteClientId?this.record(this.activeRemoteClientId):null;}
  activeRemotePolicy(){const r=this.activeRemoteRecord();return r?this.policy(r.id):null;}
  async create({label,provider='external',max_access_mode='read_only'}={}){return this.serial(async()=>{
    const now=new Date().toISOString(),id=randomUUID();
    const record={id,client_id:'remote-'+id,label:cleanLabel(label),provider:cleanProvider(provider),transport:'remote-mcp',max_access_mode:validMode(max_access_mode),built_in:false,created_at:now,updated_at:now};
    this.clients.push(record);if(!this.activeRemoteClientId)this.activeRemoteClientId=id;await this.save();await this.core.serial(()=>this.core.receipt('ai_client_created',{client_record_id:id,client_id:record.client_id,label:record.label,provider:record.provider,transport:record.transport,max_access_mode:record.max_access_mode}));this.core.emit('change');return publicRecord(record);
  });}
  async setCeiling(id,mode){mode=validMode(mode);return this.serial(async()=>{
    const record=this.record(id),before=record.max_access_mode;if(before===mode)return publicRecord(record);
    record.max_access_mode=mode;record.updated_at=new Date().toISOString();await this.save();
    await this.core.serial(()=>this.core.receipt('ai_client_policy_changed',{client_record_id:id,client_id:record.client_id,provider:record.provider,from:before,to:mode}));
    if(modeRank(mode)<modeRank(before))await this.core.cancelClientJobs(record.client_id,'AI client authority was reduced locally in PC Bridge.');
    this.core.emit('change');return publicRecord(record);
  });}
  async selectRemote(id){return this.serial(async()=>{const record=this.record(id);if(record.transport!=='remote-mcp')throw Error('Only an external AI client can be selected for the remote endpoint.');if(this.activeRemoteClientId===id)return publicRecord(record);this.activeRemoteClientId=id;await this.save();await this.core.serial(()=>this.core.receipt('ai_remote_client_selected',{client_record_id:id,client_id:record.client_id,provider:record.provider}));this.core.emit('change');return publicRecord(record);});}
  async remove(id){return this.serial(async()=>{const record=this.record(id);if(record.built_in)throw Error('The built-in ChatGPT client record cannot be removed. Lower its ceiling instead.');this.clients=this.clients.filter(x=>x.id!==id);if(this.activeRemoteClientId===id)this.activeRemoteClientId=this.clients.find(x=>x.transport==='remote-mcp')?.id??null;await this.save();await this.core.cancelClientJobs(record.client_id,'AI client record was revoked locally in PC Bridge.');await this.core.serial(()=>this.core.receipt('ai_client_removed',{client_record_id:id,client_id:record.client_id,provider:record.provider}));this.core.emit('change');return this.snapshot();});}
}

export const CHATGPT_CLIENT_RECORD_ID=BUILTIN_ID;
