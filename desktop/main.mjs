import { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, clipboard, safeStorage, protocol, net, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { BridgeCore, atomicJson, redact } from '../src/core.mjs';
import { makeMcpApp, makeRemoteMcpApp } from '../src/mcp.mjs';
import { Tunnel } from './tunnel.mjs';
import { PublicTunnel } from './public-tunnel.mjs';
import { Vault } from '../src/vault.mjs';
import { createSourceManifestSnapshot } from '../src/vault_snapshot.mjs';
import { buildSafeDiagnosticReport } from '../src/diagnostics.mjs';
import { ClientRegistry, CHATGPT_CLIENT_RECORD_ID } from '../src/client-registry.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const smoke=process.argv.includes('--smoke-test');
const testDirIndex=process.argv.indexOf('--test-data-dir');
if(testDirIndex>=0){if(!smoke)throw Error('Test data override is only available in smoke tests.');app.setPath('userData',path.resolve(process.argv[testDirIndex+1]));}
if(!app.requestSingleInstanceLock()){app.quit();}else{void boot().catch(async error=>{if(smoke){await mkdir(app.getPath('userData'),{recursive:true});await atomicJson(path.join(app.getPath('userData'),'smoke-result.json'),{ok:false,error:redact(error.message)});}else dialog.showErrorBox('PC Bridge could not start',redact(error.message));app.exit(1);});}

async function boot(){
  protocol.registerSchemesAsPrivileged([{scheme:'pcbridge',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  await app.whenReady();
  const dataDir=app.getPath('userData');await mkdir(dataDir,{recursive:true});
  if(smoke&&process.argv.includes('--smoke-corrupt-vault')){const smokeVaultDir=path.join(dataDir,'vault');await mkdir(smokeVaultDir,{recursive:true});await writeFile(path.join(smokeVaultDir,'vault.sqlite'),'not a sqlite database',{flag:'wx'});}
  const vault=Vault.open({dataDir});
  const core=await new BridgeCore({dataDir,workspaceDir:smoke?path.join(dataDir,'Workspace'):path.join(app.getPath('documents'),'PC Bridge Workspace'),nodeExecutable:process.execPath,electronNode:true,vault}).init();
  const clients=await new ClientRegistry({dataDir,core}).init();
  // Explicit local launch option used only when the owner has requested trusted
  // access (also available as the single visible Enable button).
  if(!smoke && process.argv.includes('--enable-trusted-access') && (core.accessMode!=='full'||core.fullAccessAcknowledged))await core.enable();
  let settings={tunnelId:''};try{settings=JSON.parse(await readFile(path.join(dataDir,'connection.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Connection settings are damaged.');}
  let hasKey=false;try{await readFile(path.join(dataDir,'tunnel-key.encrypted'));hasKey=true;}catch{}
  const remoteStatePath=path.join(dataDir,'remote-connection.json');
  const remoteGuestIdentityPath=path.join(dataDir,'remote-tunnel-guest.encrypted');
  let rememberedRemote=null;try{rememberedRemote=JSON.parse(await readFile(remoteStatePath,'utf8'));}catch(error){if(error.code!=='ENOENT')rememberedRemote=null;}
  const readRemoteGuestIdentity=async()=>{try{if(!safeStorage.isEncryptionAvailable())throw Error('Windows encrypted storage is unavailable.');return safeStorage.decryptString(await readFile(remoteGuestIdentityPath));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const persistRemoteGuestIdentity=async({guestToken})=>{if(!guestToken)return;if(!safeStorage.isEncryptionAvailable())throw Error('Windows encrypted storage is unavailable. Persistent Claude identity was not saved.');await writeFile(remoteGuestIdentityPath,safeStorage.encryptString(guestToken),{mode:0o600});};
  let listener=null,port=null,remoteListener=null,remotePort=null,remoteSecret=null,remoteClientRecordId=null,quitting=false;
  const localToken=randomBytes(32).toString('hex');
  let win; const changed=()=>{if(win && !win.isDestroyed())win.webContents.send('pc-bridge-change');};
  const tunnel=new Tunnel({binary:path.join(app.isPackaged?process.resourcesPath:root,'vendor','tunnel-client.exe'),dataDir,onChange:changed});
  async function persistRemoteState(){
    try{
      if(!remoteClientRecordId||!remoteSecret||!safeStorage.isEncryptionAvailable())return;
      const snap=publicTunnel.snapshot();if(!snap.mcp_url)return;
      const payload={version:1,client_record_id:remoteClientRecordId,remote_port:remotePort,mcp_url:snap.mcp_url,provider:snap.provider,ready:Boolean(snap.ready),secret_encrypted:safeStorage.encryptString(remoteSecret).toString('base64'),updated_at:new Date().toISOString()};
      rememberedRemote=payload;await atomicJson(remoteStatePath,payload);
    }catch{}
  }
  async function clearRemoteState(){rememberedRemote=null;for(const target of [remoteStatePath,remoteGuestIdentityPath]){try{await unlink(target);}catch(error){if(error.code!=='ENOENT')throw error;}}}
  const publicTunnel=new PublicTunnel({onGuestIdentity:persistRemoteGuestIdentity,onChange:()=>{changed();void persistRemoteState();}});
  core.on('change',changed);
  const state=()=>{const remoteRecord=remoteClientRecordId?clients.record(remoteClientRecordId):null;return{...core.snapshot(),vault:vault.summary(),connection:{...tunnel.snapshot(),tunnel_id:settings.tunnelId,credential_saved:hasKey},remote_connection:{...publicTunnel.snapshot(),client_record_id:remoteClientRecordId,client_label:remoteRecord?.label??null,remembered:Boolean(rememberedRemote),remembered_url:rememberedRemote?.mcp_url??null},ai_clients:clients.snapshot(),data_dir:dataDir,packaged:app.isPackaged};};
  const links={tunnels:'https://platform.openai.com/settings/organization/tunnels',keys:'https://platform.openai.com/settings/organization/api-keys',chatgpt:'https://chatgpt.com/',plugins:'https://chatgpt.com/plugins',docs:'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',claude:'https://claude.ai/customize/connectors'};
  const startLocal=async()=>{if(listener)return;const record=clients.record(CHATGPT_CLIENT_RECORD_ID);listener=await new Promise((resolve,reject)=>{const server=makeMcpApp(core,{token:localToken,client_id:record.client_id,provider:record.provider,max_access_mode:record.max_access_mode,policy_resolver:()=>clients.chatgptPolicy()}).listen(0,'127.0.0.1',()=>resolve(server));server.once('error',reject);});port=listener.address().port;};
  const stopLocal=async()=>{await core.pause({shutdown:true});await tunnel.stop();if(listener){const old=listener;listener=null;old.closeAllConnections();await new Promise(resolve=>old.close(resolve));}};
  const connectLocal=async()=>{
    if(smoke)throw Error('Network connections are disabled in the desktop smoke test.');
    if(!hasKey)throw Error('Save a restricted tunnel key first.');
    await startLocal();let key=safeStorage.decryptString(await readFile(path.join(dataDir,'tunnel-key.encrypted')));
    try{await tunnel.start({tunnelId:settings.tunnelId,key,port,localToken});}finally{key=null;}
    return state();
  };
  const startRemoteLocal=async({recordId=null,secret=null}={})=>{if(remoteListener)return;const record=recordId?clients.record(recordId):clients.activeRemoteRecord();if(!record)throw Error('Add and select an external AI client before starting the persistent endpoint.');if(recordId&&clients.snapshot().active_remote_client_id!==record.id)await clients.selectRemote(record.id);remoteClientRecordId=record.id;remoteSecret=secret??randomBytes(32).toString('hex');if(!/^[0-9a-f]{64}$/.test(remoteSecret))throw Error('Saved Claude capability secret is damaged. Revoke the endpoint and create it again.');remoteListener=await new Promise((resolve,reject)=>{const server=makeRemoteMcpApp(core,remoteSecret,{clientId:record.client_id,provider:record.provider,maxAccessMode:record.max_access_mode,policyResolver:()=>clients.policy(record.id)}).listen(0,'127.0.0.1',()=>resolve(server));server.once('error',reject);});remotePort=remoteListener.address().port;};
  const stopRemote=async({forget=false}={})=>{await publicTunnel.stop();if(remoteListener){const old=remoteListener;remoteListener=null;old.closeAllConnections();await new Promise(resolve=>old.close(resolve));}remotePort=null;remoteSecret=null;remoteClientRecordId=null;if(forget)await clearRemoteState();};
  const connectRemote=async({restore=false}={})=>{if(smoke)throw Error('Network connections are disabled in the desktop smoke test.');let guestToken=null;try{guestToken=await readRemoteGuestIdentity();if(restore){if(!rememberedRemote?.client_record_id||!rememberedRemote?.secret_encrypted)throw Error('Saved Claude connection is incomplete. Revoke it and create it again.');if(rememberedRemote.provider!=='maxoperf-guest-tunnel')throw Error('The older temporary Claude endpoint cannot survive a restart. Prepare Claude endpoint once to create a persistent address.');if(!guestToken)throw Error('Saved persistent endpoint identity is missing. Revoke it and create it again.');if(!safeStorage.isEncryptionAvailable())throw Error('Windows encrypted storage is unavailable.');const restoredSecret=safeStorage.decryptString(Buffer.from(rememberedRemote.secret_encrypted,'base64'));await startRemoteLocal({recordId:rememberedRemote.client_record_id,secret:restoredSecret});}else await startRemoteLocal();await publicTunnel.start({port:remotePort,secret:remoteSecret,guestToken});}catch(error){await stopRemote();throw error;}return state();};
  protocol.handle('pcbridge',request=>{
    const url=new URL(request.url);if(url.host!=='app')return new Response('Not found',{status:404});
    const allowed=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css']]);
    const file=allowed.get(url.pathname);if(!file)return new Response('Not found',{status:404});return net.fetch(pathToFileURL(path.join(root,'ui',file)).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  win=new BrowserWindow({width:1250,height:850,minWidth:920,minHeight:660,show:!smoke,title:'PC Bridge',backgroundColor:'#10191d',autoHideMenuBar:true,webPreferences:{preload:path.join(root,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,offscreen:smoke,backgroundThrottling:!smoke}});
  if(!smoke)app.on('second-instance',()=>{if(win&&!win.isDestroyed()){win.show();if(win.isMinimized())win.restore();win.focus();}});

  // The embedded ChatGPT surface is deliberately isolated from the local bridge.
  // It receives no preload and no Node integration, and keeps its own persistent
  // browser session so signing into ChatGPT does not expose bridge credentials.
  const chatPartition='persist:pcbridge-chatgpt';
  const chatSession=session.fromPartition(chatPartition);
  const safeChatPermission=permission=>permission==='clipboard-sanitized-write';
  chatSession.setPermissionRequestHandler((_contents,permission,callback)=>callback(safeChatPermission(permission)));
  chatSession.setPermissionCheckHandler((_contents,permission)=>safeChatPermission(permission));
  let chatView=null,chatAttached=false,chatStarted=false,chatSyncBusy=false,chatLastKey=0;
  const layoutChat=()=>{
    if(!chatAttached||!chatView)return;
    const [width,height]=win.getContentSize();
    const sidebar=width<=1050?195:228;
    const rail=width<=1050?250:300;
    chatView.setBounds({x:sidebar,y:76,width:Math.max(1,width-sidebar-rail),height:Math.max(1,height-76)});
  };
  const ensureChat=()=>{
    if(chatView&&!chatView.webContents.isDestroyed())return chatView;
    chatView=new WebContentsView({webPreferences:{partition:chatPartition,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    const userAgent=chatSession.getUserAgent().replace(/\sElectron\/[^\s]+/g,'').replace(/\sPC Bridge\/[^\s]+/g,'');
    chatView.webContents.setUserAgent(userAgent);
    chatView.webContents.setWindowOpenHandler(({url})=>/^https:\/\//i.test(url)?{action:'allow',overrideBrowserWindowOptions:{autoHideMenuBar:true,webPreferences:{partition:chatPartition,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}}}:{action:'deny'});
    chatView.webContents.on('will-navigate',(event,url)=>{if(!/^https:\/\//i.test(url))event.preventDefault();});
    chatView.webContents.on('did-fail-load',(_event,_code,_description,_url,isMainFrame)=>{if(isMainFrame)chatStarted=false;});
    chatView.webContents.on('before-input-event',()=>{chatLastKey=Date.now();});
    return chatView;
  };
  const chatHasDraft=async view=>{
    try{return await view.webContents.executeJavaScript(`(()=>{const nodes=[...document.querySelectorAll('textarea,[contenteditable=\"true\"]')];return nodes.some(el=>{const text=('value' in el?el.value:el.innerText)||'';return text.trim().length>0;});})()`);}catch{return true;}
  };
  const reloadChat=async({force=false}={})=>{
    const view=ensureChat();
    if(!chatAttached||!chatStarted||view.webContents.isDestroyed()||view.webContents.isLoading())return {reloaded:false,reason:'not-ready'};
    const url=view.webContents.getURL();
    if(!/^https:\/\/chatgpt\.com\//i.test(url))return {reloaded:false,reason:'not-chatgpt'};
    if(chatSyncBusy)return {reloaded:false,reason:'busy'};
    if(!force&&Date.now()-chatLastKey<30000)return {reloaded:false,reason:'recent-input'};
    chatSyncBusy=true;
    try{if(!force&&await chatHasDraft(view))return {reloaded:false,reason:'draft'};view.webContents.reload();return {reloaded:true,url};}
    finally{chatSyncBusy=false;}
  };
  const CHAT_AUTO_SYNC_MS=15*60*1000; // 15 minutes; manual Sync chat remains available
  const chatSyncTimer=setInterval(()=>{if(!smoke)void reloadChat();},CHAT_AUTO_SYNC_MS);
  chatSyncTimer.unref?.();
  const setChatVisible=visible=>{
    const view=ensureChat();
    if(visible){
      if(!chatAttached){win.contentView.addChildView(view);chatAttached=true;}
      layoutChat();
      if(!chatStarted&&!smoke){chatStarted=true;void view.webContents.loadURL('https://chatgpt.com/').catch(()=>{chatStarted=false;});}
    }else if(chatAttached){win.contentView.removeChildView(view);chatAttached=false;}
    return {visible:chatAttached,url:view.webContents.getURL()};
  };
  win.on('resize',layoutChat);
  const confirmFullAccess=async()=>{
    if(core.fullAccessAcknowledged)return true;
    if(smoke&&process.argv.includes('--smoke-confirm-full')){await core.acknowledgeFullAccess();return true;}
    const answer=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','I understand — enable Full access'],defaultId:0,cancelId:0,message:'Full access can run arbitrary commands as your Windows user.',detail:'Connected ChatGPT tools may run PowerShell, cmd, Node, project tests and managed processes without per-action approval. PC Bridge is not an operating-system sandbox. Use Files only or Read + approve changes when you do not need immediate command execution.'});
    if(answer.response!==1)return false;await core.acknowledgeFullAccess();return true;
  };

  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!=='pcbridge://app/')event.preventDefault();});win.webContents.on('will-attach-webview',event=>event.preventDefault());
  app.on('second-instance',()=>{if(win.isMinimized())win.restore();win.show();win.focus();});
  ipcMain.handle('pc-bridge',async(event,command,data)=>{
    if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || event.senderFrame.url!=='pcbridge://app/')throw Error('Untrusted app frame.');
    try{
      switch(command){
        case 'state':return state();
        case 'chatView':return setChatVisible(Boolean(data?.visible));
        case 'chatReload':return reloadChat({force:Boolean(data?.force)});
        case 'setAccessMode':if(data?.mode==='full'&&!await confirmFullAccess())return{cancelled:true};return core.setAccessMode(data?.mode);
        case 'setDefaultProject':return core.setDefaultProject(data?.id);
        case 'vaultMonth':return vault.month(Number(data?.year),Number(data?.month));
        case 'vaultDay':return vault.day(String(data?.day||''));
        case 'vaultSearch':return vault.search(String(data?.query||''),Number(data?.limit)||50);
        case 'vaultSnapshot':{const p=core.project(data?.id??core.defaultProjectId);const built=await createSourceManifestSnapshot({project:p,dataDir,label:String(data?.label||'PC Bridge workspace snapshot').slice(0,120)});const saved=vault.recordSnapshot(built);changed();return saved;}
        case 'gitCheckpoint':return core.createCheckpoint(data?.id??core.defaultProjectId);
        case 'gitRollback':{const checkpoint=core.checkpoints.find(c=>c.id===data?.id);if(!checkpoint)throw Error('Checkpoint not found.');const confirmation=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Rollback tracked files'],defaultId:0,cancelId:0,message:'Rollback to this PC Bridge checkpoint?',detail:`Tracked working-tree files in ${checkpoint.repo_root} will be restored to the checkpoint. HEAD and the real Git index stay unchanged; untracked files are left alone.`});return confirmation.response===1?core.rollbackCheckpoint(checkpoint.id):{cancelled:true};}
        case 'saveConnection':{
          if(tunnel.child)throw Error('Disconnect before changing connection details.');
          if(!/^tunnel_[0-9a-f]{32}$/.test(data?.tunnelId||''))throw Error('Copy a valid tunnel_… ID from OpenAI Platform.');
          if(data.key){
            if(!/^sk-[A-Za-z0-9_-]{20,}$/.test(data.key))throw Error('The runtime key does not look valid.');
            if(!safeStorage.isEncryptionAvailable())throw Error('Windows encrypted storage is unavailable. Nothing was saved.');
            await writeFile(path.join(dataDir,'tunnel-key.encrypted'),safeStorage.encryptString(data.key),{mode:0o600});hasKey=true;
          }
          settings={tunnelId:data.tunnelId};await atomicJson(path.join(dataDir,'connection.json'),settings);changed();await connectLocal();return{saved:true};
        }
        case 'connect':return connectLocal();
        case 'disconnect':await stopLocal();return state();
        case 'remoteConnect':return connectRemote();
        case 'remoteDisconnect':await stopRemote({forget:true});return state();
        case 'ensureClaudeClient':{
          if(remoteListener||publicTunnel.child){
            const active=clients.activeRemoteRecord();
            if(active?.provider==='anthropic-claude')return state();
            throw Error('Stop the current remote endpoint before switching it to Claude.');
          }
          const snapshot=clients.snapshot();
          let record=snapshot.clients.find(c=>!c.built_in&&c.provider==='anthropic-claude');
          if(!record)record=await clients.create({label:'Claude',provider:'anthropic-claude',max_access_mode:'read_only'});
          if(clients.snapshot().active_remote_client_id!==record.id)await clients.selectRemote(record.id);
          return state();
        }
        case 'clientCreate':await clients.create({label:data?.label,provider:data?.provider,max_access_mode:'read_only'});return state();
        case 'clientSetCeiling':{const record=clients.record(data?.id);if(data?.mode==='full'&&record.max_access_mode!=='full'){const answer=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Allow this AI up to Full access'],defaultId:0,cancelId:0,message:`Allow ${record.label} to use Full access when the global mode permits it?`,detail:'This client ceiling does not override the global PC Bridge mode, but when both permit it this AI may run arbitrary commands as your Windows user. PC Bridge is not an OS sandbox.'});if(answer.response!==1)return{cancelled:true};}await clients.setCeiling(record.id,data?.mode);return state();}
        case 'clientSelectRemote':if(remoteListener||publicTunnel.child)throw Error('Stop the temporary remote endpoint before switching AI clients.');await clients.selectRemote(data?.id);return state();
        case 'clientRemove':{const record=clients.record(data?.id);if(remoteClientRecordId===record.id&&(remoteListener||publicTunnel.child))throw Error('Stop the temporary remote endpoint before removing its AI client.');await clients.remove(record.id);return state();}
        case 'enable':{const mode=data?.mode??core.accessMode;if(mode==='full'&&!await confirmFullAccess())return{cancelled:true};await core.enable(mode);if(!smoke && hasKey && !tunnel.child)await connectLocal();return state();}
        case 'pause':await core.pause();return state();
        case 'demo':return core.demo();
        case 'chooseProject':{
          const selected=await dialog.showOpenDialog(win,{title:'Add an existing project folder',properties:['openDirectory']});if(selected.canceled)return{cancelled:true};
          return core.addProject(selected.filePaths[0]);
        }
        case 'createProject':{
          const selected=await dialog.showSaveDialog(win,{title:'Create a new PC Bridge workspace',defaultPath:path.join(app.getPath('documents'),'New PC Bridge Workspace'),buttonLabel:'Create workspace',nameFieldLabel:'Workspace folder name'});
          if(selected.canceled||!selected.filePath)return{cancelled:true};
          const project=await core.createProject(selected.filePath,path.basename(selected.filePath));return{created:true,project};
        }
        case 'removeProject':await core.removeProject(data.id);return state();
        case 'chooseTest':{
          const p=core.project(data.id);const selected=await dialog.showOpenDialog(win,{title:'Choose or re-approve a trusted JavaScript test entry',defaultPath:p.root,properties:['openFile'],filters:[{name:'JavaScript',extensions:['mjs','cjs','js']}]});if(selected.canceled)return{cancelled:true};
          const rel=path.relative(p.root,selected.filePaths[0]).split(path.sep).join('/');await core.setTask(p.id,rel);return state();
        }
        case 'chooseProjectTask':{
          const p=core.project(data.id);const selected=await dialog.showOpenDialog(win,{title:'Approve a JavaScript project task',defaultPath:p.root,properties:['openFile'],filters:[{name:'JavaScript',extensions:['mjs','cjs','js']}]});if(selected.canceled)return{cancelled:true};
          const rel=path.relative(p.root,selected.filePaths[0]).split(path.sep).join('/');await core.grantProjectTask(p.id,rel);return state();
        }
        case 'reapproveProjectTask':{
          const p=core.project(data.id),grant=(p.project_tasks||[]).find(t=>t.id===data.taskId);if(!grant)throw Error('Project task grant not found.');await core.grantProjectTask(p.id,grant.path,grant.name);return state();
        }
        case 'revokeProjectTask':await core.revokeProjectTask(data.id,data.taskId);return state();
        case 'approve':await core.approve(data.id);return state();
        case 'reject':await core.cancel(data.id);return state();
        case 'restore':{
          const j=core.jobs.find(j=>j.id===data.id);if(!j)throw Error('Edit not found.');
          const confirmation=await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Restore previous text'],defaultId:0,cancelId:0,message:`Restore ${j.path}?`,detail:'Only this edit will be reverted. Restore is refused if the file has changed since the edit.'});if(confirmation.response===1)await core.restore(data.id);return state();
        }
        case 'openLink':if(!Object.hasOwn(links,data.id))throw Error('Unknown destination.');await shell.openExternal(links[data.id]);return{};
        case 'openProject':{const p=core.project(data.id);const result=await shell.openPath(p.root);if(result)throw Error(result);return{};}
        case 'copy':if(typeof data?.text!=='string'||data.text.length>6000)throw Error('Invalid copy request.');clipboard.writeText(data.text);return{};
        case 'exportReport':{
          const selected=await dialog.showSaveDialog(win,{title:'Save a safe connection report',defaultPath:'PC-Bridge-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});if(selected.canceled)return{cancelled:true};
          const status=core.status(),report=buildSafeDiagnosticReport({version:app.getVersion(),platform:process.platform,buildChannel:'private-alpha',connection:tunnel.snapshot(),credentialSaved:hasKey,status,lastRequest:core.lastSeen,verifiedAt:core.verifiedAt,projectCount:core.projects.length,receiptCount:core.auditCount,receiptHead:core.auditHash,vaultSummary:vault.summary()});
          await writeFile(selected.filePath,JSON.stringify(report,null,2));return{saved:true};
        }
        default:throw Error('Unsupported local action.');
      }
    }catch(error){throw Error(redact(error.message));}
  });
  await win.loadURL('pcbridge://app/');
  if(!smoke && hasKey && settings.tunnelId && core.trustedAccess)void connectLocal().catch(()=>changed());
  if(!smoke && rememberedRemote?.provider==='maxoperf-guest-tunnel')void connectRemote({restore:true}).catch(()=>changed());
  win.on('close',event=>{if(quitting)return;event.preventDefault();win.hide();changed();});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;clearInterval(chatSyncTimer);void stopRemote().catch(()=>{}).then(()=>stopLocal()).finally(()=>{vault.close();app.quit();});});
  if(smoke){
    try{
      await new Promise(resolve=>setTimeout(resolve,500));
      const first=await win.webContents.executeJavaScript('({title:document.title,body:document.body.innerText,bridge:typeof window.bridge.call,require:typeof window.require})');
      if(!first.body.includes('Your AI. Your computer.') || first.bridge!=='function' || first.require!=='undefined')throw Error('Desktop renderer isolation or first screen failed.');
      if(!first.body.includes('PRIVATE ALPHA · 0.5.16'))throw Error('Build-channel/version badge did not render from state.');
      await win.webContents.executeJavaScript('document.querySelector("[data-page=projects]").click()');
      await new Promise(resolve=>setTimeout(resolve,100));
      if(!await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-action=create-project]"))'))throw Error('Create workspace UI action is missing.');
      await win.webContents.executeJavaScript('document.querySelector("[data-page=home]").click()');
      const chatNav=await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-page=chat]"))');
      const calendarNav=await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-page=calendar]"))');
      if(!calendarNav)throw Error('Calendar navigation item is missing.');
      await win.webContents.executeJavaScript('document.querySelector("[data-page=calendar]").click()');
      await new Promise(resolve=>setTimeout(resolve,500));
      const calendarState=await win.webContents.executeJavaScript('({body:document.body.innerText,main:document.querySelector("#main")?.innerText||"",active:document.querySelector("[data-page=calendar]")?.className||"",toast:document.querySelector("#toast")?.innerText||""})');
      await atomicJson(path.join(dataDir,'calendar-debug.json'),calendarState);
      await writeFile(path.join(dataDir,'calendar.png'),(await win.webContents.capturePage()).toPNG());
      if(!calendarState.main.toLowerCase().includes('vault & timeline') || !calendarState.main.includes('Calendar'))throw Error('Calendar/Vault page did not render: '+calendarState.main.slice(0,240));
      if(process.argv.includes('--smoke-corrupt-vault')&&!calendarState.main.includes('Vault index recovered.'))throw Error('Vault recovery warning did not render from real recovered state.');
      await win.webContents.executeJavaScript('document.querySelector("[data-page=home]").click()');
      await new Promise(resolve=>setTimeout(resolve,150));
      if(!chatNav)throw Error('ChatGPT navigation item is missing.');
      const chatIpc=await win.webContents.executeJavaScript('window.bridge.call("chatView",{visible:false})');
      if(chatIpc?.visible)throw Error('Chat view IPC returned an invalid hidden state.');
      const chatAttach=setChatVisible(true);
      if(!chatAttach.visible||!chatAttached)throw Error('Embedded ChatGPT WebContentsView did not attach.');
      setChatVisible(false);
      if(chatAttached)throw Error('Embedded ChatGPT WebContentsView did not detach.');
      if(core.projects.length!==1 || core.status().access_enabled)throw Error('Fresh install must provide one workspace and wait for the upfront choice.');
      if(core.fullAccessAcknowledged)throw Error('Fresh install unexpectedly acknowledged Full access.');let fullGate=false;try{await core.enable('full');}catch(error){fullGate=/acknowledged locally/.test(error.message);}if(!fullGate)throw Error('Full access core gate did not block unacknowledged enable.');
      await win.webContents.executeJavaScript('document.querySelector("[data-action=enable]").click()');
      for(let i=0;i<30&&!core.trustedAccess;i++)await new Promise(resolve=>setTimeout(resolve,100));
      if(!core.trustedAccess)throw Error('One-click trusted access did not enable.');
      const recoveryData=path.join(dataDir,'Vault recovery smoke');const rv1=Vault.open({dataDir:recoveryData});rv1.close();await writeFile(path.join(recoveryData,'vault','vault.sqlite'),'not a sqlite database');const rv2=Vault.open({dataDir:recoveryData});const recoverySummary=rv2.summary();if(!recoverySummary.recovery||!recoverySummary.recovery.quarantined?.length)throw Error('Vault corruption recovery did not quarantine the damaged index.');rv2.close();
      if(!await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-mode=files_only]"))'))throw Error('Files only access card is missing.');if(!await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-mode=project_tasks]"))'))throw Error('Project Tasks access card is missing.');
      await core.setAccessMode('files_only');const fileOnlyWrite=await core.submit('write',{project_id:core.workspaceProjectId,path:'files-only-smoke.txt',content:'files only\n',expected_sha256:null,request_key:'files-only-write'},{wait:true});if(fileOnlyWrite.state!=='succeeded')throw Error('Files only mode did not permit protected file write.');
      let blockedKinds=0;for(const [kind,input] of [['command',{project_id:core.workspaceProjectId,shell:'node',command:'console.log(1)',request_key:'files-only-command'}],['test',{project_id:core.workspaceProjectId,request_key:'files-only-test'}],['process',{project_id:core.workspaceProjectId,shell:'node',command:'setTimeout(()=>{},1000)',request_key:'files-only-process'}]]){try{await core.submit(kind,input,{wait:true});}catch(error){if(/Files only mode/.test(error.message))blockedKinds++;}}if(blockedKinds!==3)throw Error('Files only mode failed to block all execution classes.');
      const projectTaskPath=path.join(core.project(core.workspaceProjectId).root,'project-task-smoke.mjs');await writeFile(projectTaskPath,"console.log('PROJECT_TASK_SMOKE')\n");const projectTaskGrant=await core.grantProjectTask(core.workspaceProjectId,'project-task-smoke.mjs','Smoke task');await core.setAccessMode('project_tasks');let arbitraryBlocked=false;try{await core.submit('command',{project_id:core.workspaceProjectId,shell:'node',command:'console.log(1)',request_key:'project-task-command'},{wait:true});}catch(error){arbitraryBlocked=/Project Tasks mode/.test(error.message);}if(!arbitraryBlocked)throw Error('Project Tasks mode did not block arbitrary command execution.');const projectTaskRun=await core.submit('project_task',{project_id:core.workspaceProjectId,task_id:projectTaskGrant.id,request_key:'project-task-run'},{wait:true});if(projectTaskRun.state!=='succeeded'||!projectTaskRun.result.stdout_tail.includes('PROJECT_TASK_SMOKE'))throw Error('Project Tasks mode did not execute the locally pinned task.');await core.setAccessMode('full');
      const createRoot=path.join(dataDir,'Created workspace');const created=await core.createProject(createRoot,'Created workspace');if(created.root!==createRoot||core.defaultProjectId!==created.id)throw Error('Create workspace core flow failed.');
      const guardAfterCreate=core.remoteStatus().workspace_guard;if(core.remoteProjectId(null,guardAfterCreate)!==created.id)throw Error('Fresh workspace guard did not resolve active project.');const oldGuard=guardAfterCreate;await core.setDefaultProject(core.workspaceProjectId);let staleRejected=false;try{core.remoteProjectId(null,oldGuard);}catch{staleRejected=true;}if(!staleRejected)throw Error('Workspace guard survived an active-workspace change.');if(core.remoteProjectId(created.id,null)!==created.id)throw Error('Explicit project_id should not require a workspace guard.');await core.removeProject(created.id);
      const demo=await core.demo();await new Promise(resolve=>setTimeout(resolve,300));
      const smokeSnapshot=await createSourceManifestSnapshot({project:core.project(demo.id),dataDir,label:'Smoke source snapshot'});
      const storedSnapshot=vault.recordSnapshot(smokeSnapshot);
      const smokeManifest=JSON.parse(await readFile(storedSnapshot.output_path,'utf8'));
      if(smokeManifest.file_count<3 || !storedSnapshot.sha256 || vault.summary().snapshots<1)throw Error('Vault source snapshot smoke test failed.');
      const capture=await win.webContents.capturePage();await writeFile(path.join(dataDir,'desktop.png'),capture.toPNG());
      await win.webContents.executeJavaScript('document.querySelector("[data-page=connect]").click()');
      await new Promise(resolve=>setTimeout(resolve,200));await writeFile(path.join(dataDir,'connect.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript('document.querySelector("[data-page=remote]").click()');await new Promise(resolve=>setTimeout(resolve,100));if(!await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-action=claude-connect]"))'))throw Error('Guided Claude connect action is missing.');
      await win.webContents.executeJavaScript('window.bridge.call("ensureClaudeClient")');
      for(let i=0;i<40&&!clients.snapshot().clients.some(c=>!c.built_in&&c.provider==='anthropic-claude');i++)await new Promise(resolve=>setTimeout(resolve,50));
      const guidedClaude=clients.snapshot().clients.find(c=>!c.built_in&&c.provider==='anthropic-claude');
      if(!guidedClaude||guidedClaude.max_access_mode!=='read_only'||clients.snapshot().active_remote_client_id!==guidedClaude.id)throw Error('Guided Claude setup did not create/select a Read only Claude client.');
      await win.webContents.executeJavaScript('window.bridge.call("clientRemove",{id:'+JSON.stringify(guidedClaude.id)+'})');
      for(let i=0;i<40&&clients.snapshot().clients.some(c=>c.id===guidedClaude.id);i++)await new Promise(resolve=>setTimeout(resolve,50));
      if(clients.snapshot().clients.some(c=>c.id===guidedClaude.id)||clients.snapshot().active_remote_client_id!==null)throw Error('Guided Claude smoke cleanup failed.');
      await win.webContents.executeJavaScript(`(()=>{document.querySelector('details.card')?.setAttribute('open','');const name=document.querySelector('#client-label');const provider=document.querySelector('#client-provider');if(!name||!provider)throw Error('AI client form missing');name.value='Claude Draft';name.focus();name.setSelectionRange(6,6);provider.value='google-gemini';return true;})()`);
      changed();await new Promise(resolve=>setTimeout(resolve,300));
      const draftAfterRefresh=await win.webContents.executeJavaScript(`(()=>{const name=document.querySelector('#client-label');const provider=document.querySelector('#client-provider');return{value:name?.value||'',provider:provider?.value||'',focus:document.activeElement?.id||'',caret:name?.selectionStart??null};})()`);
      if(draftAfterRefresh.value!=='Claude Draft'||draftAfterRefresh.provider!=='google-gemini'||draftAfterRefresh.focus!=='client-label'||draftAfterRefresh.caret!==6)throw Error('AI client form draft did not survive a bridge state refresh: '+JSON.stringify(draftAfterRefresh));
      await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.client-ceiling');if(!s)throw Error('Client ceiling dropdown missing');s.__pcbridgeKeep='alive';s.focus();return true;})()`);
      changed();await new Promise(resolve=>setTimeout(resolve,300));
      const ceilingStable=await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.client-ceiling');return{sameMarker:s?.__pcbridgeKeep||null,focus:document.activeElement===s};})()`);
      if(ceilingStable.sameMarker!=='alive'||ceilingStable.focus!==true)throw Error('AI client authority dropdown was re-rendered while focused: '+JSON.stringify(ceilingStable));
      await win.webContents.executeJavaScript(`document.querySelector('[data-page=remote]').focus()`);await new Promise(resolve=>setTimeout(resolve,220));
      const initialClients=clients.snapshot();
      const builtInChat=initialClients.clients.find(c=>c.built_in&&c.label==='ChatGPT');
      if(!builtInChat||builtInChat.max_access_mode!=='full')throw Error('Built-in ChatGPT client record is missing or wrong.');
      const chatRemoveBefore=await win.webContents.executeJavaScript("(()=>[...document.querySelectorAll('[data-action=client-remove]')].some(x=>x.dataset.clientId==="+JSON.stringify(builtInChat.id)+"))()");
      if(chatRemoveBefore)throw Error('Built-in ChatGPT record exposed a Remove control.');
      await win.webContents.executeJavaScript("(()=>{const name=document.querySelector('#client-label');const provider=document.querySelector('#client-provider');name.value='Claude Smoke';provider.value='anthropic-claude';document.querySelector('[data-action=client-create]').click();})()");
      for(let i=0;i<40&&!clients.snapshot().clients.some(c=>c.label==='Claude Smoke');i++)await new Promise(resolve=>setTimeout(resolve,50));
      let smokeClaude=clients.snapshot().clients.find(c=>c.label==='Claude Smoke');
      if(!smokeClaude||smokeClaude.max_access_mode!=='read_only')throw Error('External AI did not start at Read only.');
      if(clients.snapshot().active_remote_client_id!==smokeClaude.id)throw Error('First external AI was not selected as the remote client.');
      let renderedClaude=false;
      for(let i=0;i<40&&!renderedClaude;i++){renderedClaude=await win.webContents.executeJavaScript("(()=>[...document.querySelectorAll('.client-ceiling')].some(x=>x.dataset.clientId==="+JSON.stringify(smokeClaude.id)+"))()");if(!renderedClaude)await new Promise(resolve=>setTimeout(resolve,50));}
      if(!renderedClaude)throw Error('Claude client row did not render after creation.');
      const changedInDom=await win.webContents.executeJavaScript("(()=>{const s=[...document.querySelectorAll('.client-ceiling')].find(x=>x.dataset.clientId==="+JSON.stringify(smokeClaude.id)+");if(!s)return false;s.value='project_tasks';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
      if(!changedInDom)throw Error('Claude ceiling dropdown was not available.');
      for(let i=0;i<40&&clients.record(smokeClaude.id).max_access_mode!=='project_tasks';i++)await new Promise(resolve=>setTimeout(resolve,50));
      smokeClaude=clients.record(smokeClaude.id);
      if(smokeClaude.max_access_mode!=='project_tasks')throw Error('Rendered client ceiling control did not update locally.');
      let clientFile=null,persistedClaude=null;
      for(let i=0;i<40;i++){clientFile=JSON.parse(await readFile(path.join(dataDir,'ai-clients.json'),'utf8'));persistedClaude=clientFile.clients.find(c=>c.id===smokeClaude.id);if(persistedClaude?.max_access_mode==='project_tasks'&&clientFile.active_remote_client_id===smokeClaude.id)break;await new Promise(resolve=>setTimeout(resolve,50));}
      if(!persistedClaude||persistedClaude.max_access_mode!=='project_tasks'||clientFile.active_remote_client_id!==smokeClaude.id)throw Error('AI client UI changes were not persisted to disk.');
      let renderedRemove=false;
      for(let i=0;i<40&&!renderedRemove;i++){renderedRemove=await win.webContents.executeJavaScript("(()=>[...document.querySelectorAll('[data-action=client-remove]')].some(x=>x.dataset.clientId==="+JSON.stringify(smokeClaude.id)+"))()");if(!renderedRemove)await new Promise(resolve=>setTimeout(resolve,50));}
      if(!renderedRemove)throw Error('Claude Remove control did not render.');
      await win.webContents.executeJavaScript("(()=>{const b=[...document.querySelectorAll('[data-action=client-remove]')].find(x=>x.dataset.clientId==="+JSON.stringify(smokeClaude.id)+");b?.click();})()");
      for(let i=0;i<40&&clients.snapshot().clients.some(c=>c.id===smokeClaude.id);i++)await new Promise(resolve=>setTimeout(resolve,50));
      if(clients.snapshot().clients.some(c=>c.id===smokeClaude.id)||clients.snapshot().active_remote_client_id!==null)throw Error('Rendered client removal did not revoke the external AI record.');
      const afterClientRemoval=clients.snapshot();
      if(!afterClientRemoval.clients.some(c=>c.id===builtInChat.id&&c.built_in))throw Error('Built-in ChatGPT record disappeared after external removal.');
      let clientFileAfter=null;
      for(let i=0;i<40;i++){clientFileAfter=JSON.parse(await readFile(path.join(dataDir,'ai-clients.json'),'utf8'));if(!clientFileAfter.clients.some(c=>c.id===smokeClaude.id)&&clientFileAfter.active_remote_client_id===null)break;await new Promise(resolve=>setTimeout(resolve,50));}
      if(clientFileAfter.clients.some(c=>c.id===smokeClaude.id)||clientFileAfter.active_remote_client_id!==null)throw Error('External AI removal did not persist to disk.');
      const failed=await core.submit('test',{project_id:demo.id,request_key:'desktop-before'},{wait:true});
      if(failed.state!=='failed'||failed.result?.exit_code===0)throw Error('Bundled runtime did not detect the practice bug.');
      const source=await core.read(demo.id,'calculator.mjs');const edit=await core.submit('write',{project_id:demo.id,path:'calculator.mjs',content:source.content.replace('a - b','a + b'),expected_sha256:source.sha256,request_key:'desktop-fix'});
      await new Promise(resolve=>setTimeout(resolve,250));
      await win.webContents.executeJavaScript('document.querySelector("[data-page=activity]").click();document.querySelector("[data-action=review]").click()');
      await new Promise(resolve=>setTimeout(resolve,250));
      if(!await win.webContents.executeJavaScript('document.querySelector("#review").open && document.querySelector("#review-content").innerText.includes("return a + b") && !document.querySelector("#approve-button")'))throw Error('Completed edit receipt was not shown without an approval button.');
      await writeFile(path.join(dataDir,'review.png'),(await win.webContents.capturePage()).toPNG());
      if(edit.state!=='succeeded')throw Error('The direct edit did not save.');
      const passed=await core.submit('test',{project_id:demo.id,request_key:'desktop-after'},{wait:true});
      if(passed.state!=='succeeded'||passed.result?.exit_code!==0||!/pass 2/.test(passed.result.stdout))throw Error('Bundled runtime did not pass the corrected practice tests.');
      const command=await core.submit('command',{shell:'node',command:'console.log("Hello from the bundled PC Bridge runtime!")',request_key:'desktop-command'},{wait:true});
      if(command.state!=='succeeded'||!command.result.stdout.includes('Hello from'))throw Error('Bundled direct command failed.');
      const fakeKey='s'+'k-'+'Z'.repeat(32),fakeBearer='Bearer '+'Y'.repeat(24),fakeTunnel='tunnel_'+'a'.repeat(32),fakeUserPath='C:\\Users\\DiagnosticUser\\private.txt';const diag=buildSafeDiagnosticReport({version:app.getVersion(),platform:process.platform,buildChannel:'private-alpha',connection:{state:'error',ready:false,detail:[fakeKey,fakeBearer,fakeTunnel,fakeUserPath].join(' | '),key:'LEAKME_CONNECTION'},credentialSaved:true,status:core.status(),lastRequest:core.lastSeen,verifiedAt:core.verifiedAt,projectCount:core.projects.length,receiptCount:core.auditCount,receiptHead:core.auditHash,vaultSummary:{...vault.summary(),db_path:'LEAKME_VAULT_PATH'}});const diagText=JSON.stringify(diag);if([fakeKey,'DiagnosticUser',fakeTunnel,'LEAKME_CONNECTION','LEAKME_VAULT_PATH'].some(x=>diagText.includes(x))||/Bearer Y{12}/.test(diagText))throw Error('Safe diagnostic report leaked poisoned input.');if(diag.build_channel!=='private-alpha'||diag.version!==app.getVersion())throw Error('Diagnostic build identity is wrong.');
      await atomicJson(path.join(dataDir,'smoke-result.json'),{ok:true,renderer_isolated:true,version:app.getVersion(),encryption_available:safeStorage.isEncryptionAvailable(),bundled_runtime:process.versions.node,workspace_ready:true,workspace_create_ready:true,workspace_guard_ready:true,files_only_ready:true,project_tasks_ready:true,vault_recovery_ready:true,vault_recovery_ui_ready:true,full_access_warning_gate_ready:true,diagnostic_export_safe:true,build_channel_ready:true,vault_ready:vault.summary().projects>=1,calendar_ready:true,single_upfront_choice:true,no_local_approval:true,practice_failed_before:true,direct_edit:true,practice_passed_after:true,direct_command:true});
    }catch(error){await atomicJson(path.join(dataDir,'smoke-result.json'),{ok:false,error:redact(error.message)});process.exitCode=1;}
    quitting=true;await stopLocal();vault.close();win.destroy();app.quit();
  }
}
