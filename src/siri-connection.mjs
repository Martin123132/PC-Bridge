// Native PC Bridge service for Apple Shortcuts. No listener until locally enabled.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink, realpath, stat } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createSiriShortcutsApp, parseSiriIntent, SIRI_ACTIONS } from './siri-shortcuts.mjs';
import { clientAllows } from './client-policy.mjs';
import { inspectCodexTasks, inspectBuildEvidence } from './siri-evidence.mjs';
import { atomicJson } from './core.mjs';

const FILENAME = 'siri-shortcuts.encrypted';
const EVIDENCE_FILE = 'siri-evidence-project.json';
const DEFAULT_PORT = 48764;
const APPLE_MUSIC_ID = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';
const EDGE_EXE = path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe');
const GOOGLE_HOME='https://www.google.com/';
const WINDOWS_APPS = Object.freeze({
  open_notepad: () => path.join(process.env.SystemRoot || 'C:\\Windows','System32','notepad.exe'),
  open_calculator: () => path.join(process.env.SystemRoot || 'C:\\Windows','System32','calc.exe'),
  open_explorer: () => path.join(process.env.SystemRoot || 'C:\\Windows','explorer.exe'),
});
const PRIVATE4 = ip => /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) ||
  /^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(ip);

export function selectSiriAddress(interfaces = os.networkInterfaces()) {
  const candidates=[];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const e of entries || []) {
      if (e.internal || (e.family!=='IPv4' && e.family!==4) || !PRIVATE4(e.address)) continue;
      if (/vEthernet|WSL|Docker|Hyper-V|VPN|VirtualBox|VMware|Tailscale|ZeroTier/i.test(name)) continue;
      candidates.push({name, address:e.address});
    }
  }
  candidates.sort((a,b)=> Number(/wi-?fi|wlan|wireless/i.test(b.name)) - Number(/wi-?fi|wlan|wireless/i.test(a.name)));
  if (!candidates.length) throw Error('No private Wi-Fi or Ethernet address found. Connect the PC to a private home network.');
  return candidates[0].address;
}

function processRunning(image) {
  if (process.platform !== 'win32') return false;
  try {
    const list=execFileSync(path.join(process.env.SystemRoot||'C:\\Windows', 'System32','tasklist.exe'), [
      '/FI','IMAGENAME eq '+image,'/FO','CSV','/NH'
    ], {windowsHide:true, encoding:'utf8', timeout:3000});
    return list.toLowerCase().includes(('"'+image+'"').toLowerCase());
  } catch { return false; }
}

function launchApp(program,args=[]) {
  return new Promise((resolve,reject)=>{
    const child=spawn(program, args, {windowsHide:false,shell:false,stdio:'ignore',detached:true});
    child.once('error', reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
}

// UWP activation through Windows Start-Process. Explorer spawning alone did not open Apple Music.
function activateAppleMusic() {
  if(process.platform!=='win32')return Promise.reject(Error('Apple Music requires Windows.'));
  const windows=process.env.SystemRoot||'C:\\Windows';
  const shell=path.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const explorer=path.join(windows,'explorer.exe').replaceAll("'","''");
  const command="Start-Process -FilePath '"+explorer+"' -ArgumentList 'shell:AppsFolder\\"+APPLE_MUSIC_ID+"' -ErrorAction Stop";
  return new Promise((resolve,reject)=>{
    const child=spawn(shell,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,shell:false,stdio:'ignore'});
    let settled=false;
    const finish=err=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(err)reject(err);else resolve();
    };
    const timer=setTimeout(()=>{child.kill();finish(Error('Apple Music activation timed out.'));},12000);
    child.once('error',error=>finish(error));
    child.once('close',code=>finish(code===0?null:Error('Windows could not activate Apple Music.')));
  });
}


function appleMusicWindowVisible() {
  if(process.platform!=='win32')return Promise.resolve(false);
  const windows=process.env.SystemRoot||'C:\\Windows';
  const shell=path.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const script="$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\n$root=[System.Windows.Automation.AutomationElement]::RootElement\n$windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)\nforeach($window in $windows){\n  try {\n    $title=$window.Current.Name\n    $bounds=$window.Current.BoundingRectangle\n    if($title -like 'Apple Music*' -and -not $window.Current.IsOffscreen -and $bounds.Width -gt 100 -and $bounds.Height -gt 100){\n      Write-Output 'APPLE_MUSIC_VISIBLE_WINDOW'\n      exit 0\n    }\n  } catch {}\n}\nexit 1";
  return new Promise(resolve=>{
    let completed=false,output='';
    const done=found=>{if(completed)return;completed=true;clearTimeout(timer);resolve(found);};
    const child=spawn(shell,['-NoProfile','-NonInteractive','-Command',script],{
      windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']
    });
    const timer=setTimeout(()=>{child.kill();done(false);},5500);
    child.stdout.on('data',data=>{output+=data.toString('utf8').slice(0,120);});
    child.once('error',()=>done(false));
    child.once('close',code=>done(code===0&&output.includes('APPLE_MUSIC_VISIBLE_WINDOW')));
  });
}

export function createSiriController({
  core, clients, dataDir, encrypt, decrypt, addressResolver=selectSiriAddress,
  port=DEFAULT_PORT, appLauncher=launchApp, isRunning=processRunning, allowLoopbackForTests=false, minIntervalMs=300,
  codexReader=inspectCodexTasks, evidenceReader=inspectBuildEvidence, fileExists=fs.existsSync,
  musicActivator=activateAppleMusic, musicProcessPolls=16, musicProcessPollDelayMs=300,
  musicWindowVisible=appleMusicWindowVisible, musicStableDelayMs=5000,
  saveCredential=writeFile, readCredential=readFile, removeCredential=unlink,
} = {}) {
  if (!core || !clients || typeof encrypt!=='function' || typeof decrypt!=='function' || !dataDir) throw Error('Siri controller requires PC Bridge policy and Windows encrypted storage.');
  if (!Number.isInteger(port) || port<0 || (port!==0 && port<1025) || port>65535) throw Error('Invalid Siri service port.');
  const filename=path.join(dataDir,FILENAME), evidenceFile=path.join(dataDir,EVIDENCE_FILE);
  let evidenceFolder=null;
  try {
    const saved=JSON.parse(fs.readFileSync(evidenceFile,'utf8'));
    if (saved.version===1 && typeof saved.folder==='string' && path.isAbsolute(saved.folder)) evidenceFolder=saved.folder;
  } catch(e) { if(e.code!=='ENOENT') evidenceFolder=null; }
  let server=null, host='', credential=null, lastAction=null;
  const snapshot=()=>{const activePort=server?.listening?server.address().port:null;return{ready:Boolean(activePort),host:activePort?host:null,port:activePort,address:activePort?'http://'+host+':'+activePort+'/v1/action':null,credential_saved:Boolean(credential),evidence_folder:evidenceFolder,last_action:lastAction};};
  async function key(){
    if (credential) return credential;
    let secret;
    try {
      secret=decrypt(await readCredential(filename));
      if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('Stored Siri pairing is invalid. Rotate the Siri pairing key.');
    } catch(e) {
      if (e?.code!=='ENOENT') throw e;
      secret=randomBytes(32).toString('hex');
      await saveCredential(filename,encrypt(secret),{flag:'wx',mode:0o600});
    }
    credential=secret;
    return secret;
  }
  const authorise=async action=>{
    try { core.checkAccess(); } catch { return false; } // global Pause applies on every request
    const policy=clients.siriPolicy();
    if (['status','check_codex','codex_tasks','accessibility_build'].includes(action)) return clientAllows(policy,'read');
    // A fixed desktop-app launch is intentionally disabled outside Full
    // global access AND the separate Siri Full ceiling. No arbitrary command
    // or path input can reach the child process.
    if (core.accessMode!=='full') return false;
    return clientAllows(policy,'arbitrary_exec');
  };
  const record=async ({action,outcome})=>{
    await core.serial(()=>core.receipt('siri_shortcuts_action',{tool:action,outcome,client_id:'siri-shortcuts',provider:'apple-siri',transport:'local-shortcuts'}));
    lastAction={action,outcome,at:new Date().toISOString()};
    core.lastSeen=lastAction.at;
    core.emit('change');
  };
  const handlers={
    status:async()=>{
      const free=(os.freemem()/1024**3).toFixed(1), total=(os.totalmem()/1024**3).toFixed(1);
      return 'Your Windows PC is online. PC Bridge is running. Available memory: '+free+' gigabytes out of '+total+' gigabytes.';
    },
    check_codex:async()=>isRunning('Codex.exe')||isRunning('node_repl.exe')
      ? 'Codex-related processes are running. This does not establish whether a specific job has finished.'
      : 'No known Codex-related processes were detected.',
  };
  handlers.open_apple_music=async()=>{
    await musicActivator();
    let appeared=false;
    for(let i=0;i<musicProcessPolls;i++){
      if(isRunning('AppleMusic.exe')){appeared=true;break;}
      if(i+1<musicProcessPolls)await new Promise(resolve=>setTimeout(resolve,musicProcessPollDelayMs));
    }
    if(!appeared)throw Error('Apple Music did not start.');
    await new Promise(resolve=>setTimeout(resolve,musicStableDelayMs));
    if(!isRunning('AppleMusic.exe') || !await musicWindowVisible()){
      throw Error('Apple Music closed or failed to display a visible Windows app window.');
    }
    return 'Apple Music window is open on your Windows PC.';
  };
  handlers.open_google=async()=>{
    if(!fileExists(EDGE_EXE))throw Error('Microsoft Edge is not installed at the expected path.');
    await appLauncher(EDGE_EXE,[GOOGLE_HOME]);
    return 'Opened Google in Microsoft Edge.';
  };
  handlers.search_google=async query=>{
    const validated=parseSiriIntent({action:'search_google',query});
    if(!validated)throw Error('Google search query must be a short piece of text.');
    if(!fileExists(EDGE_EXE))throw Error('Microsoft Edge is not installed at the expected path.');
    const url=new URL('https://www.google.com/search');url.searchParams.set('q',validated.query);
    await appLauncher(EDGE_EXE,[url.href]);
    return 'Searched Google for '+validated.query+'.';
  };
  handlers.codex_tasks=async()=>codexReader().message;
  handlers.accessibility_build=async()=>evidenceReader({folder:evidenceFolder}).message;
  handlers.review_accessibility_build=async()=>{
    const report=evidenceReader({folder:evidenceFolder});
    if(!report.resultsFolder)return report.message+' No results folder can be opened.';
    await appLauncher(WINDOWS_APPS.open_explorer(),[report.resultsFolder]);
    return report.message+' Opened the saved results folder on Windows.';
  };
  for(const [action,program] of Object.entries(WINDOWS_APPS)) {
    handlers[action]=async()=>{
      await appLauncher(program());
      return action==='open_notepad'?'Opened Notepad on your Windows PC.':
        action==='open_calculator'?'Opened Calculator on your Windows PC.':'Opened File Explorer on your Windows PC.';
    };
  }
  const close=async()=>{
    if(!server)return;
    const s=server;server=null;host='';
    s.closeAllConnections();
    await new Promise(resolve=>s.close(resolve));
  };
  return {
    snapshot,
    async performLocally(input){
      const intent=parseSiriIntent(input);
      const action=intent?.action;
      if(!action||!SIRI_ACTIONS.includes(action))throw Error('Unsupported Siri virtual-phone action.');
      if(!await authorise(action))throw Error('This action is not enabled by PC Bridge and Siri client permissions.');
      await record({action,outcome:'requested'});
      try{
        const message=await handlers[action](intent.query);
        if(typeof message!=='string'||message.length>500)throw Error('Invalid local action result.');
        await record({action,outcome:'ok'});
        return {action,message};
      }catch(error){await record({action,outcome:'failed'});throw error;}
    },
    async setEvidenceFolder(folder){
      if(typeof folder!=='string'||!path.isAbsolute(folder))throw Error('Choose a Windows folder locally.');
      const target=await realpath(folder),info=await stat(target);
      if(!info.isDirectory())throw Error('The chosen evidence folder is not a directory.');
      await atomicJson(evidenceFile,{version:1,folder:target});
      evidenceFolder=target;
      await core.serial(()=>core.receipt('siri_evidence_folder_selected',{client_id:'siri-shortcuts'}));
      core.emit('change');return snapshot();
    },
    async start(){
      if (server?.listening)return snapshot();
      const address=addressResolver(); // never 0.0.0.0
      if (!PRIVATE4(address) && !(allowLoopbackForTests && address==='127.0.0.1')) throw Error('Siri service must bind to a private IPv4 address.');
      const token=await key();
      const app=createSiriShortcutsApp({token,handlers,authorise,record,minIntervalMs});
      try{
        await new Promise((resolve,reject)=>{
          const onError=error=>{app.off('listening',onListen);reject(error);};
          const onListen=()=>{app.off('error',onError);resolve();};
          app.once('error',onError); app.once('listening',onListen);
          app.listen(port,address);
        });
        host=address;server=app;
      }catch(e){if(app.listening)app.close();throw e;}
      await core.serial(()=>core.receipt('siri_shortcuts_started',{client_id:'siri-shortcuts',host,port:server.address().port}));
      core.emit('change'); return snapshot();
    },
    async stop(){
      await close();
      await core.serial(()=>core.receipt('siri_shortcuts_stopped',{client_id:'siri-shortcuts'}));
      core.emit('change'); return snapshot();
    },
    async pairing(){
      if(!server?.listening)throw Error('Start the Siri connection on this PC first.');
      return {address:snapshot().address,token:await key()};
    },
    async rotate(){
      await close(); credential=null;
      try {await removeCredential(filename);}catch(e){if(e.code!=='ENOENT')throw e;}
      await core.serial(()=>core.receipt('siri_shortcuts_pairing_revoked',{client_id:'siri-shortcuts'}));
      core.emit('change');
      return snapshot();
    },
    close,
  };
}
