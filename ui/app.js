// Read-only presentation. Never changes access, the latch, or worker admission.
function protectionSnapshot(manager) {
  try {
    const s=manager.status();
    const states=['ordinary','starting','protected','checking','stopping','held'];
    if(!states.includes(s.state)||typeof s.protected_only!=='boolean'||
       s.host_routes_blocked!==s.protected_only||((s.state==='ordinary')===s.protected_only))throw Error('Inconsistent status');
    return {version:1,state:s.state,host_routes_blocked:s.host_routes_blocked};
  } catch {return {version:1,state:'unavailable',host_routes_blocked:null};}
}

function accessPresentation(snapshot) {
  const p=snapshot?.chaff_protection;
  const labels={read_only:'Read only',files_only:'Files only',project_tasks:'Project Tasks',approve_changes:'Read + approve',full:'Full access'};
  const savedMode=labels[snapshot?.access_mode]||'Unknown';
  const names={starting:'Starting protection',protected:'Protected task running',checking:'Checking protected result',stopping:'Stopping protected task',held:'Host access held'};
  const known=p?.version===1&&typeof p.host_routes_blocked==='boolean'&&
    (p.state==='ordinary'?!p.host_routes_blocked:Boolean(names[p.state])&&p.host_routes_blocked);
  if(!known)return {restricted:true,state:'unavailable',label:'Protection status unavailable',savedMode,
    detail:'Bridge cannot confirm its protection status. Check Chaff locally before continuing. No access change has been made.'};
  if(p.host_routes_blocked)return {restricted:true,state:p.state,label:names[p.state],savedMode,
    detail:p.state==='held'?'Ordinary host access is still blocked. No task is available to the agent. Open Chaff to start another protected task or leave protection. Leaving protection keeps ordinary access paused.':
      p.state==='protected'?'The agent can work only in the approved isolated copy. Ordinary host files and commands remain blocked.':
      p.state==='checking'?'The result is being checked in a separate isolated machine. Ordinary host access and agent commands remain blocked.':
      p.state==='stopping'?'The protected task is stopping. Ordinary host access remains blocked.':'The isolated copy is starting. Ordinary host access remains blocked.'};
  return {restricted:false,state:snapshot.access_enabled?'ordinary':'paused',label:snapshot.access_enabled?savedMode:'Access paused',savedMode,detail:''};
}

const main=document.querySelector('#main');
let current='home',state=null,busy=false,reviewId=null,chatAttached=false,reviewRequest=0;
let renderedPage=null,renderedMainHtml=null;
let calendarCursor=new Date(),calendarSelected='',calendarMonthData=null,calendarDayData=null,calendarBusy=false;
const draft={tunnelId:'',key:'',clientLabel:'',clientProvider:'anthropic-claude',activeLimit:null,backgroundLimit:null};
let deferredBridgeRefresh=false;
let siriPairing=null;
let siriGoogleDraft='';
let siriPhoneResult=null;
const clientControlActive=()=>{const el=document.activeElement;return Boolean(el&&(el.id==='client-label'||el.id==='client-provider'||el.id==='active-limit'||el.id==='background-limit'||el.classList?.contains('client-ceiling')));};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timeFormatter=new Intl.DateTimeFormat([],{hour:'2-digit',minute:'2-digit'});
const time=value=>{if(!value)return 'Not yet';const date=new Date(value);return Number.isNaN(date.getTime())?'Invalid Date':timeFormatter.format(date);};
const vaultRecoveryNotice=()=>{const r=state?.vault?.recovery;if(!r)return '';const count=Array.isArray(r.quarantined)?r.quarantined.length:0,rebuilt=r.snapshots_reindexed;return '<div class="tip amber"><strong>Vault index recovered.</strong> PC Bridge quarantined '+count+' damaged database file'+(count===1?'':'s')+' instead of deleting them and rebuilt the local index from normal bridge state'+(rebuilt?' plus '+Number(rebuilt.indexed||0)+' standalone snapshot manifest'+(Number(rebuilt.indexed||0)===1?'':'s'):'')+'. Recovery: '+esc(new Date(r.recovered_at).toLocaleString())+'.</div>';};
const button=(action,label,kind='secondary',extra='')=>'<button class="button '+kind+'" data-action="'+action+'" '+extra+'>'+label+'</button>';
const modeName=mode=>mode==='read_only'?'Read only':mode==='files_only'?'Files only':mode==='project_tasks'?'Project Tasks':mode==='approve_changes'?'Read + approve':'Full access';
const modeCard=(mode,title,body)=>'<button class="mode-option '+(state.access_mode===mode?'active':'')+'" data-action="set-mode" data-mode="'+mode+'"><strong>'+title+'</strong><span>'+body+'</span></button>';
const dateKey=d=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return y+'-'+m+'-'+day;};
calendarSelected=dateKey(new Date());
async function loadCalendar(){if(calendarBusy||current!=='calendar')return;calendarBusy=true;try{calendarMonthData=await call('vaultMonth',{year:calendarCursor.getFullYear(),month:calendarCursor.getMonth()+1});calendarDayData=await call('vaultDay',{day:calendarSelected});render();}catch{}finally{calendarBusy=false;}}
const backgroundJob=j=>j.kind==='process'&&j.scheduling_class==='background_service';
const jobTitle=j=>backgroundJob(j)?'Background: '+j.service_name:j.kind==='write'?'Write '+j.path:j.kind==='command'?'Command':j.kind==='process'?'Managed process':j.kind==='project_task'?'Project task '+(j.task_name||j.task||''):'Tests';
function renderRail(){const rail=document.querySelector('#activity-rail');const visible=current==='chat'&&state;rail.hidden=!visible;if(!visible)return;const jobs=[...state.jobs].reverse().slice(0,8);const selected=state.projects.find(p=>p.id===state.default_project_id);const checkpoints=(state.checkpoints||[]).filter(c=>c.project_id===state.default_project_id).reverse();const latest=checkpoints[0];rail.innerHTML='<div class="rail-head"><div class="eyebrow">Local execution</div><h2>PC activity</h2></div><label class="rail-label">Active workspace<select id="rail-workspace">'+state.projects.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===state.default_project_id?'selected':'')+'>'+esc(p.name)+'</option>').join('')+'</select></label><div class="rail-path">'+esc(selected?.root||state.workspace_path)+'</div><div class="rail-policy"><span class="tag">'+esc(accessPresentation(state).label)+'</span><span>'+(accessPresentation(state).restricted?'Saved ordinary mode: '+esc(modeName(state.access_mode)):(state.access_enabled?'Access on':'Paused'))+'</span></div><div class="rail-section"><div class="rail-title">Git safety · local only</div><div class="actions">'+button('git-checkpoint','Checkpoint','secondary')+(latest?button('git-rollback','Rollback','ghost','data-id="'+latest.id+'"'):'')+'</div><p class="small-note">'+(latest?'Latest: '+time(latest.created_at)+' · tracked files only':'No local checkpoint for this workspace yet.')+'</p></div><div class="rail-note">Files, diffs and process output shown to the model are <strong>untrusted data</strong>, never instruction authority.</div><div class="rail-section"><div class="rail-title">Recent work</div>'+(jobs.length?jobs.map(j=>'<button class="rail-job" data-action="review" data-id="'+esc(j.id)+'"><span class="tag '+esc(j.state)+'">'+esc(j.state)+'</span><strong>'+esc(jobTitle(j))+'</strong><small>'+esc(j.project_name)+(['process','project_task'].includes(j.kind)&&j.pid?' · PID '+j.pid:'')+' · '+time(j.created_at)+'</small>'+(['process','project_task'].includes(j.kind)&&j.stdout_tail?'<code>'+esc(j.stdout_tail.trim().split(/\r?\n/).slice(-1)[0]).slice(0,110)+'</code>':'')+'</button>').join(''):'<p class="small-note">No jobs yet.</p>')+'</div>';}
function toast(message,error=false){const el=document.querySelector('#toast');el.textContent=message;el.className=error?'error':'';el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.hidden=true,error?11000:5000);}
async function call(command,data){try{return await window.bridge.call(command,data);}catch(error){toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /,''),true);throw error;}}
function prompts(){return{
  verify:'Use PC Bridge. Call bridge_verify with code '+state.verification_code+', then bridge_status. Report the actual results.',
  hello:'Use PC Bridge to create a new hello-world.mjs in the default workspace containing console.log("Hello from my PC!"). Then run it using bridge_run_command with shell=node and command=import("./hello-world.mjs"). Follow the current PC Bridge access mode; if a job is pending, wait for the owner to approve it locally. Poll the job until finished and tell me the real output. Read any existing file before replacing it.',
  practice:'Use PC Bridge to inspect the Practice project, run its tests, fix the addition bug and run the tests again. Follow the current PC Bridge access mode, wait for local approval when required, and report actual results and receipts.',
  claudecheck:'Use PC Bridge. Call bridge_status only. Report the actual provider, transport, client maximum authority, global access mode, active workspace and whether project-task execution is available. Do not run or modify anything.'
};}
async function syncChat(){
  const wanted=current==='chat';
  if(wanted===chatAttached)return;
  chatAttached=wanted;
  try{await call('chatView',{visible:wanted});}
  catch{chatAttached=!wanted;}
}
function render(){
  if(!state)return;
  const focus=document.activeElement,field=focus?.id,caret=focus?.selectionStart;
  if(document.querySelector('#tunnel-id'))draft.tunnelId=document.querySelector('#tunnel-id').value;
  if(document.querySelector('#runtime-key'))draft.key=document.querySelector('#runtime-key').value;
  if(document.querySelector('#client-label'))draft.clientLabel=document.querySelector('#client-label').value;
  if(document.querySelector('#client-provider'))draft.clientProvider=document.querySelector('#client-provider').value;
  document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===current));
  const pill=document.querySelector('#connection-pill');const remoteReady=Boolean(state.remote_connection?.ready);pill.textContent=state.connection.ready?(remoteReady?'ChatGPT + remote endpoint ready':'ChatGPT tunnel ready'):remoteReady?'Remote endpoint ready':state.connection.state==='connecting'||state.remote_connection?.state==='connecting'?'Preparing endpoint...':'Not connected';pill.classList.toggle('connected',state.connection.ready||remoteReady);
  renderAccessChrome();
  const buildBadge=document.querySelector('#build-badge');if(buildBadge)buildBadge.textContent=(state.build_channel==='private-alpha'?'PRIVATE ALPHA':'BUILD')+' · '+state.version;
  document.querySelector('#pause-top').disabled=!state.access_enabled;
  document.querySelector('#sync-chat').hidden=current!=='chat';
  const nextMainHtml=({home,chat,connect,remote,projects,calendar,activity,siri,workSessions}[current])();
  if(renderedPage!==current||renderedMainHtml!==nextMainHtml){
    main.innerHTML=nextMainHtml;renderedPage=current;renderedMainHtml=nextMainHtml;
  }
  updateWorkClockLabels();
  void syncChat();
  renderRail();
  if(field&&['tunnel-id','runtime-key','client-label'].includes(field)){const replacement=document.getElementById(field);replacement?.focus();if(caret!==null)replacement?.setSelectionRange(caret,caret);}
}
function home(){if(accessPresentation(state).restricted)return protectedAccessHome();const approval=state.access_mode==='approve_changes'?'Required':state.access_mode==='read_only'?'Writes blocked':state.access_mode==='files_only'?'Execution blocked':state.access_mode==='project_tasks'?'Pinned tasks only':'None';return '<div class="eyebrow">One connection. Your real PC.</div><h1>Your AI. Your computer.</h1><p class="intro">Choose how much authority ChatGPT gets locally. The selected mode is enforced by PC Bridge, below the model.</p>'+vaultRecoveryNotice()+
  '<section class="hero"><div><span class="tag">'+(state.connection.ready&&state.access_enabled?'READY TO WORK':'LET’S GET YOU READY')+'</span><h2>'+(state.access_enabled?modeName(state.access_mode):'Connect once.<br>Then choose the boundary.')+'</h2><p>Your workspace is already created. PC Bridge remembers both the connection and your local access mode.</p>'+button('go-connect',state.connection.ready?'Connection settings →':'Connect ChatGPT →','primary')+'</div><div class="connection-art"><div class="art-box"><strong>✳</strong>ChatGPT</div><span class="art-line"></span><div class="art-box you"><strong>⇄</strong>PC Bridge</div><span class="art-line"></span><div class="art-box"><strong>▣</strong>Your PC</div></div></section>'+
  '<div class="grid-3"><div class="card"><div class="metric-label">WORKSPACE</div><div class="metric-value">Ready</div><div class="metric-note">Shared project boundary</div></div><div class="card"><div class="metric-label">LOCAL APPROVALS</div><div class="metric-value">'+approval+'</div><div class="metric-note">'+esc(modeName(state.access_mode))+'</div></div><div class="card"><div class="metric-label">LAST REQUEST</div><div class="metric-value">'+time(state.last_seen)+'</div><div class="metric-note">Recorded on this computer</div></div></div>'+
  '<div class="section-title"><h2>Access mode</h2><span class="tag">LOCAL POLICY</span></div><div class="mode-grid">'+modeCard('read_only','Read only','List and read shared workspace files. No writes or execution.')+modeCard('files_only','Files only','Read and edit shared files with hash checks and backups. No execution.')+modeCard('project_tasks','Project Tasks','Protected file edits plus locally pinned tests/tasks. No arbitrary command text or arbitrary managed processes.')+modeCard('approve_changes','Read + approve changes','Reads happen automatically. Every write, command, test, task and managed process waits for your approval here.')+modeCard('full','Full access','Current fast path. Writes and arbitrary execution run immediately as your Windows user.')+'</div>'+
  '<div class="section-title"><h2>PC Bridge access</h2><span class="tag">'+(state.access_enabled?'ENABLED':'PAUSED')+'</span></div><div class="card"><h3>'+(state.access_enabled?modeName(state.access_mode)+' is active.':'Access is paused.')+'</h3><p>'+esc(state.access_model)+'</p><p class="small-note">Mode changes are enforced locally. Switching to a stricter mode cancels or parks active mutating requests. Closing PC Bridge stops the connection.</p>'+(!state.access_enabled?button('enable','Enable PC Bridge access','primary'):'<div class="tip">Use the mode buttons above to change the boundary instantly, or Pause access to revoke all work.</div>')+'</div>'+
  '<div class="section-title"><h2>Try Hello World</h2></div><div class="card"><p class="project-path">'+esc(state.workspace_path)+'</p><p>Copy this prompt into ChatGPT. In Full access it runs directly; in Project Tasks and Files only the protected file write can run but this arbitrary command is blocked; in Read + approve the exact write and command wait in Activity; in Read only it is blocked.</p><div class="actions">'+button('copy-hello','Copy Hello World prompt','primary')+button('open-project','Open workspace','secondary','data-id="'+state.default_project_id+'"')+'</div></div><p class="footer-note">Private preview · Windows · Local policy is enforced below the model.</p>';}
function chat(){return '<div class="eyebrow">ChatGPT inside PC Bridge</div><h1>Opening your ChatGPT workspace…</h1><p class="intro">ChatGPT runs in an isolated browser surface inside PC Bridge. Sign in once here; the session is kept separately from the bridge itself.</p><div class="card"><h3>One window, both halves.</h3><p>Use ChatGPT here while PC Bridge remains connected to your local machine. Switch to Overview, Workspaces or Activity at any time; your ChatGPT page stays alive in the background.</p></div>'; }
function connect(){return '<div class="eyebrow">Guided setup</div><h1>Connect once. Know it worked.</h1><p class="intro">Sign in on OpenAI’s pages. Everything local stays in this app.</p><div class="steps">'+
  '<section class="card step"><div class="step-number">1</div><div><h2>Create the private connection</h2><p>Sign in with the account you use for ChatGPT. In Tunnels, create a tunnel named PC Bridge and associate it with your ChatGPT workspace as well as your Platform organisation. Copy its tunnel_ ID.</p>'+button('link-tunnels','Open OpenAI Tunnels ↗')+'<p class="small-note">Using an existing tunnel? Stop its old local client first. Only one bridge should serve a tunnel.</p></div></section>'+
  '<section class="card step"><div class="step-number">2</div><div><h2>Save and connect</h2><p>Create a restricted runtime key with only <strong>Tunnels → Read + Use</strong>. PC Bridge does not call a paid model API. Paste the key here, never into chat.</p>'+button('link-keys','Open OpenAI API keys ↗')+
  '<div class="form-row"><label>Tunnel ID<input id="tunnel-id" autocomplete="off" spellcheck="false" placeholder="tunnel_…" value="'+esc(draft.tunnelId||state.connection.tunnel_id)+'"></label><label>Restricted runtime key<input id="runtime-key" type="password" autocomplete="off" placeholder="'+(state.connection.credential_saved?'Saved — leave blank to keep it':'Paste your key here')+'" value="'+esc(draft.key)+'"></label></div><p class="small-note">Save & connect stores the key encrypted for your Windows account at '+esc(state.data_dir)+'\\tunnel-key.encrypted. It is never shown in activity.</p><div class="actions">'+(state.connection.state==='stopped'||state.connection.state==='error'?button('save-connection','Save & connect','primary')+(state.connection.credential_saved?button('connect','Reconnect saved connection','ghost'):''):button('disconnect','Disconnect','secondary'))+'</div><div class="tip">'+esc(state.connection.detail)+'</div></div></section>'+
  '<section class="card step"><div class="step-number">3</div><div><h2>Add it to ChatGPT</h2><ol><li>Open ChatGPT Settings → Security and login → Developer mode.</li><li>In Plugins, choose Create app (or +), name it PC Bridge and select Tunnel.</li><li>Choose your tunnel. Set upstream authentication to No Auth: the private OpenAI tunnel authenticates the connection.</li><li>Create/connect it and choose your preferred ChatGPT permissions. PC Bridge applies the local access mode you select on Overview; Project Tasks permits only locally pinned tests/tasks plus protected file edits, Files only blocks execution, and Read + approve changes requires per-action approval.</li></ol><div class="actions">'+button('link-plugins','Open ChatGPT Plugins ↗')+button('copy-tunnel','Copy tunnel ID','ghost')+'</div><p class="small-note">After updating PC Bridge: open this connection’s settings in ChatGPT, select Refresh, then start a fresh chat. Account/workspace policies still apply.</p></div></section>'+
  '<section class="card step"><div class="step-number">4</div><div><h2>Ask it to say hello</h2><p>Enable trusted access on Overview. Start a normal ChatGPT chat, select PC Bridge from the tools menu and paste the Hello World prompt. No project setup or local review step.</p><div class="actions">'+button('copy-hello','Copy Hello World prompt','primary')+button('link-chatgpt','Open ChatGPT ↗','ghost')+'</div><details><summary>Connection-only check</summary><div class="code-prompt">'+esc(prompts().verify)+'</div>'+button('copy-verify','Copy check','ghost')+'<p>'+ (state.verified_at?'Matching check received at '+time(state.verified_at):'The check only confirms the connection; it is not another permission gate.')+'</p></details></div></section></div>'+
  '<div class="section-title"><h2>Need a hand?</h2>'+button('export','Save safe diagnostic report','ghost')+'</div><div class="card"><p><strong>Missing tools:</strong> Refresh the existing app connection in ChatGPT, then start a new chat. <strong>Key rejected:</strong> check key expiry and tunnel permissions. <strong>No connection:</strong> use the same workspace on both sites and keep this PC awake. Platform permission or safety blocks must be handled in ChatGPT; PC Bridge cannot override them.</p></div>';}
function siri(){
  const s=state.siri_connection||{},online=Boolean(s.ready),client=(state.ai_clients?.clients||[]).find(c=>c.client_id==='siri-shortcuts');
  const permitted=state.access_enabled===true;
  const actions=[
    {label:'Codex',glyph:'&lt;/&gt;',tone:'codex',command:'codex_tasks'},
    {label:'Files',glyph:'▣',tone:'files',command:'open_explorer'},
    {label:'Google',glyph:'G',tone:'google',command:'open_google'},
    {label:'Music',glyph:'♫',tone:'music',command:'open_apple_music'},
    {label:'Windows',glyph:'⊞',tone:'windows',command:'status'},
    {label:'Notepad',glyph:'✎',tone:'notes',command:'open_notepad'},
    {label:'Calculator',glyph:'＋',tone:'calculator',command:'open_calculator'},
    {label:'Activity',glyph:'◷',tone:'activity',command:null}
  ];
  const tiles=actions.map(a=>'<button type="button" class="siri-app" data-action="'+(a.command?'siri-run':'siri-show-activity')+'"'+(a.command?' data-siri-action="'+esc(a.command)+'"':'')+' aria-label="'+esc(a.label)+'"><span class="siri-app-icon '+a.tone+'">'+a.glyph+'</span><span class="siri-app-name">'+esc(a.label)+'</span></button>').join('');
  const entries=[];
  if(s.last_action?.action)entries.push({title:'Siri: '+String(s.last_action.action).replace(/_/g,' '),desc:String(s.last_action.outcome||'recorded'),date:s.last_action.at});
  for(const job of (state.jobs||[]).slice(-3).reverse()){
    if(!job?.created_at)continue;
    entries.push({title:String(job.project_name||'PC Bridge'),desc:String(job.kind||'task')+' · '+String(job.state||'recorded'),date:job.created_at});
    if(entries.length>=3)break;
  }
  const feed=entries.length?entries.map(item=>'<div class="siri-recent-row"><span class="siri-recent-dot"></span><div><strong>'+esc(item.title)+'</strong><small>'+esc(item.desc)+'</small></div><time>'+time(item.date)+'</time></div>').join(''):'<p class="siri-no-activity">No recorded activity yet. Actions will appear here after use.</p>';
  const pairing=online&&siriPairing?'<div class="siri-secret"><strong>Private pairing data — keep off public screenshots.</strong><span>Shortcut POST URL</span><code>'+esc(siriPairing.address)+'</code><span>Header x-siri-key</span><code>'+esc(siriPairing.token)+'</code><small>JSON body: {"request":"Ask for Input"}</small></div>':'';
  const statusText=online?'Siri endpoint ready':'Siri endpoint stopped';
  const now=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return `<div class="siri-page">
    <div class="siri-page-header"><div><div class="siri-page-kicker">PC BRIDGE / APPLE SHORTCUTS</div><h1>Siri's virtual phone</h1><p>Her own phone-shaped workspace inside the PC Bridge you already use.</p></div><span class="siri-connection-tag ${online?'online':'offline'}"><span></span>${esc(statusText)}</span></div>
    <div class="siri-layout">
      <div class="siri-phone-column">
        <div class="siri-phone-frame"><div class="siri-device"><div class="siri-phone-top"><span>${esc(now)}</span><div class="siri-island" aria-hidden="true"></div><span>● ▂▃▅</span></div>
          ${siriPhoneResult?`<section class="siri-app-opened"><button type="button" class="siri-back" data-action="siri-phone-back">‹ Home</button><div class="siri-opened-emblem">✦</div><h2>${esc(siriPhoneResult.title)}</h2><p>${esc(siriPhoneResult.message)}</p><span class="siri-opened-info">Action recorded in PC Bridge</span></section>`:`<div class="siri-phone-greeting"><span>SIRI WORKSPACE</span><strong>Your PC. In your pocket.</strong></div><div class="siri-app-grid">${tiles}</div><section class="siri-phone-feed"><div class="siri-feed-heading"><strong>Recent activity</strong><span>Live records</span></div>${feed}</section>`}
          <div class="siri-phone-spacer"></div><div class="siri-phone-dock"><span>◉</span><span>✦</span><span>◈</span><span>⚙</span></div><div class="siri-home-line" aria-hidden="true"></div>
        </div></div><p class="siri-phone-note">The icons invoke permitted PC Bridge actions. They do not emulate iOS applications.</p>
      </div>
      <div class="siri-controls">
        <section class="siri-control-card"><div class="siri-control-heading"><div><div class="siri-overline">LOCAL CONNECTION</div><h2>Connect Siri</h2></div><span class="siri-led ${online?'on':''}"></span></div><p>${online?'The phone workspace is listening on your private network.':'The phone works locally; start the network connection when you want Siri to use it.'}</p>${online?'<p class="siri-bound-address">'+esc(s.host)+':'+s.port+'</p>':''}<div class="actions">${online?button('siri-stop','Stop connection','secondary')+button('siri-rotate','Revoke pairing','danger-outline'):button('siri-start','Start Siri connection','primary')}</div></section>
        <section class="siri-control-card"><div class="siri-overline">FIRST TWO REAL APPS</div><h2>Apple Music + Google</h2><div class="siri-action-row"><span class="siri-chip music">♫</span><div><strong>Apple Music</strong><small>Open the installed Windows application</small></div>${button('siri-open-music','Open','secondary')}</div><label class="siri-search-label" for="siri-google-query">Google search</label><div class="siri-search-form"><input id="siri-google-query" type="text" maxlength="120" autocomplete="off" placeholder="What should Siri search for?" value="${esc(siriGoogleDraft)}">${button('siri-google-search','Search','primary')}</div><p class="siri-hint">Siri can also say “Search Google for …” through her paired Shortcut. Searches open in Microsoft Edge.</p></section>
        <section class="siri-control-card"><div class="siri-overline">PERMISSIONS</div><h2>Allowed capabilities</h2><p>Read-only actions are available when PC Bridge access is on. Opening Music, Google, Files or other desktop apps needs both PC Bridge Full access and Siri Full access.</p>${client?'<label class="siri-policy-label">Siri maximum authority<select class="client-ceiling" data-client-id="'+esc(client.id)+'">'+clientCeilingOptions(client)+'</select></label>':'<p>Siri permissions will appear after the built-in client loads.</p>'}<div class="siri-permission-note">Global PC Bridge: ${permitted?esc(modeName(state.access_mode)):'Paused'} · Siri: ${esc(modeName(client?.max_access_mode||'read_only'))}</div></section>
        <details class="siri-control-card siri-details"><summary>Pairing and build evidence</summary><div class="siri-details-body"><div class="actions">${online?button('siri-pairing','Show private pairing details','secondary')+button('siri-copy-setup','Copy Shortcut instructions','ghost'):''}${button('siri-choose-evidence','Choose build evidence folder','secondary')}</div><p class="siri-hint">Evidence: ${esc(s.evidence_folder||'Not selected')}</p>${pairing}<p class="siri-hint">Local HTTP on trusted Wi-Fi only. The master Calendar still tracks PC Bridge events.</p></div></details>
      </div>
    </div>
  </div>`;
}
function clientCeilingOptions(c){return [['read_only','Read only'],['files_only','Files only'],['project_tasks','Project Tasks'],['full','Full access']].map(([value,label])=>'<option value="'+value+'" '+(c.max_access_mode===value?'selected':'')+'>'+label+'</option>').join('');}
function remote(){
  const r=state.remote_connection||{},registry=state.ai_clients||{clients:[],active_remote_client_id:null},clients=registry.clients||[];
  const active=clients.find(c=>c.id===registry.active_remote_client_id)||null;
  const claudeClients=clients.filter(c=>!c.built_in&&c.provider==='anthropic-claude');
  const claude=(active?.provider==='anthropic-claude'?active:claudeClients[0])||null;
  const activeIsClaude=Boolean(active&&active.provider==='anthropic-claude');
  const ready=Boolean(r.ready&&activeIsClaude),connecting=r.state==='connecting';
  const safeUrl=ready?(r.mcp_url||''):'';
  const status=ready?'ENDPOINT READY':connecting?'PREPARING ENDPOINT':r.state==='error'?'ERROR':'NOT PREPARED';
  const claudePolicy=claude?'<label class="small-note">Claude maximum authority<select class="client-ceiling" data-client-id="'+esc(claude.id)+'">'+clientCeilingOptions(claude)+'</select></label><p class="small-note">This ceiling is stored on this PC. The global PC Bridge mode and Claude ceiling both apply; the stricter boundary wins.</p>':'<p>PC Bridge will create a local Claude identity at <strong>Read only</strong> the first time you connect. You can raise its ceiling here afterwards.</p>';
  const primary=(r.state==='stopped'||r.state==='error')?button('claude-connect','Prepare Claude endpoint','primary'):button('remote-disconnect','Revoke endpoint','secondary');
  const verified=ready?'<section class="card step"><div class="step-number">2</div><div><h2>Endpoint ready — add PC Bridge to Claude</h2><p>PC Bridge has prepared and verified the public HTTPS route. Claude is not connected until you add this URL to your own Claude account. Treat the final path like a password: it contains a capability secret.</p><div class="code-prompt">'+esc(safeUrl)+'</div><div class="actions">'+button('copy-remote-url','Copy MCP URL','primary')+button('link-claude','Open Claude connectors','ghost')+'</div><ol><li>In Claude connectors choose <strong>Add custom connector</strong>.</li><li>Name it <strong>PC Bridge</strong>.</li><li>Paste the MCP server URL above.</li><li>Choose <strong>Continue</strong>.</li><li>Set Claude tool permissions however you prefer; PC Bridge still enforces the local ceiling shown above.</li></ol></div></section><section class="card step"><div class="step-number">3</div><div><h2>Prove Claude reached this PC</h2><p>Start a normal Claude chat with the PC Bridge connector enabled, then send this connection-only check. It reads status and changes nothing.</p><div class="code-prompt">'+esc(prompts().claudecheck)+'</div><div class="actions">'+button('copy-claudecheck','Copy Claude connection check','primary')+'</div></div></section>':'';
  const wait=connecting?'<div class="tip amber"><strong>Preparing endpoint.</strong> Claude is not connected yet. PC Bridge will not reveal or copy the MCP URL until the public hostname resolves and the request reaches this local Bridge. '+esc(r.detail||'')+'</div>':'<div class="tip">'+esc(r.detail||'Claude endpoint is stopped.')+'</div>';
  const rows=clients.map(c=>'<div class="vault-file"><div class="project-head"><div><span>'+esc(c.label)+'</span><small>'+esc(c.provider)+' · '+esc(c.transport)+(c.built_in?' · built in':'')+'</small></div><span class="tag">'+(c.id===registry.active_remote_client_id?'REMOTE SELECTED':esc(modeName(c.max_access_mode)).toUpperCase())+'</span></div><label class="small-note">Maximum authority<select class="client-ceiling" data-client-id="'+esc(c.id)+'">'+clientCeilingOptions(c)+'</select></label><div class="actions">'+(!c.built_in&&c.id!==registry.active_remote_client_id?button('client-select-remote','Use for remote endpoint','ghost','data-client-id="'+c.id+'"'):'')+(!c.built_in?button('client-remove','Remove','danger-outline','data-client-id="'+c.id+'"'):'')+'</div></div>').join('');
  return '<div class="eyebrow">Claude standard chat</div><h1>Connect your Claude account to this PC.</h1><p class="intro">PC Bridge first prepares a private MCP endpoint on this computer. It does not contain or sign in to any Claude account. Once the endpoint is ready, you add its URL to your own Claude connector.</p><div class="steps"><section class="card step"><div class="step-number">1</div><div><div class="project-head"><div><h2>Prepare the Claude endpoint</h2><p>'+(claude?'Local Claude identity: <strong>'+esc(claude.label)+'</strong>':'No Claude identity has been created yet.')+'</p></div><span class="tag">'+esc(status)+'</span></div>'+claudePolicy+'<div class="actions">'+primary+(ready?button('link-claude','Open Claude connectors','ghost'):'')+'</div>'+wait+'<p class="small-note">PC Bridge keeps this endpoint alive when you close the app window, so your Claude connector does not get torn down just because you dismissed the window. Reopen PC Bridge from its shortcut. Use Revoke endpoint only when you actually want to delete this Claude route and its saved address.</p></div></section>'+verified+'</div><details class="card"><summary><strong>Advanced: other MCP clients and local policy records</strong></summary><p class="small-note">Claude is the guided path above. This section keeps the provider-neutral client registry available for Gemini, voice clients and other MCP chats.</p>'+rows+'<div class="day-section"><h3>Add external AI</h3><div class="form-row"><label>Name<input id="client-label" autocomplete="off" maxlength="60" placeholder="Another AI" value="'+esc(draft.clientLabel)+'"></label><label>Provider<select id="client-provider"><option value="anthropic-claude" '+(draft.clientProvider==='anthropic-claude'?'selected':'')+'>Claude</option><option value="google-gemini" '+(draft.clientProvider==='google-gemini'?'selected':'')+'>Gemini</option><option value="voice-remote" '+(draft.clientProvider==='voice-remote'?'selected':'')+'>Voice Remote</option><option value="external" '+(draft.clientProvider==='external'?'selected':'')+'>Other MCP chat</option></select></label></div><div class="actions">'+button('client-create','Add AI client','secondary')+'</div></div></details><p class="footer-note">Client permission changes are local-only and receipted. Lowering or revoking a client cancels its active Bridge jobs.</p>';
}
function projects(){const cards=state.projects.map(p=>{const tasks=Array.isArray(p.project_tasks)?p.project_tasks:[];const testText=p.task?esc(p.task)+(p.task_grant?' · local fingerprint '+esc(String(p.task_grant.project_fingerprint||'').slice(0,12))+'…':' · not locally pinned'):'Not selected';const taskRows=tasks.length?'<div class="day-section"><h3>Approved project tasks</h3>'+tasks.map(t=>'<div class="vault-file"><span>'+esc(t.name||'Project task')+'</span><code>'+esc(t.path)+'</code><small>Task '+esc(String(t.sha256||'').slice(0,12))+'… · project '+esc(String(t.project_fingerprint||'').slice(0,12))+'…</small><div class="actions">'+button('reapprove-project-task','Re-approve','ghost','data-id="'+p.id+'" data-task-id="'+t.id+'"')+button('revoke-project-task','Revoke','danger-outline','data-id="'+p.id+'" data-task-id="'+t.id+'"')+'</div></div>').join('')+'</div>':'<p class="small-note">No approved project tasks yet.</p>';return '<section class="card project"><div class="project-head"><h2>'+esc(p.name)+'</h2><span class="tag">'+(p.id===state.default_project_id?'ACTIVE':'BOOKMARK')+'</span></div><p class="project-path">'+esc(p.root)+'</p><p class="small-note">Saved Node test: '+testText+'</p><p class="small-note">Project Tasks grants pin both the entry file and the complete bridge-visible project fingerprint. Any protected source edit makes every grant stale until you re-approve it locally.</p><div class="actions">'+(p.id!==state.default_project_id?button('set-default','Use as active','primary','data-id="'+p.id+'"'):'')+button('open-project','Open folder','secondary','data-id="'+p.id+'"')+button('choose-test','Choose / re-approve test','ghost','data-id="'+p.id+'"')+button('choose-project-task','Approve project task','ghost','data-id="'+p.id+'"')+(p.name!=='Workspace'?button('unshare','Remove bookmark','ghost','data-id="'+p.id+'"'):'')+'</div>'+taskRows+'</section>';}).join('');return '<div class="page-heading"><div><div class="eyebrow">Execution roots</div><h1>Choose the active workspace.</h1><p class="intro">The desktop Active workspace is a convenience default. Remote calls that omit project_id must first acknowledge the current workspace; changing Active invalidates that acknowledgement. Different Git/workspace roots receive independent execution lanes.</p></div><div class="actions">'+button('create-project','+ Create workspace','primary')+button('add-project','Add existing','secondary')+'</div></div><div class="tip amber">The active workspace is a default, not an authority expansion. Project-task grants are local-only policy and never created or refreshed by ChatGPT.</div><div class="grid-2">'+cards+'</div><p class="footer-note">Commands and tasks in the same execution root remain serialized; different roots can run concurrently.</p>';}
function calendar(){const vault=state.vault||{},cursor=calendarCursor,y=cursor.getFullYear(),m=cursor.getMonth(),counts=new Map((calendarMonthData?.days||[]).map(x=>[x.day,x])),first=new Date(y,m,1),pad=(first.getDay()+6)%7,days=new Date(y,m+1,0).getDate(),cells=[];for(let i=0;i<pad;i++)cells.push('<div class="cal-day blank"></div>');for(let d=1;d<=days;d++){const key=dateKey(new Date(y,m,d)),info=counts.get(key),sel=key===calendarSelected;cells.push('<button class="cal-day '+(info?'has-work ':'')+(sel?'selected':'')+'" data-action="cal-day" data-day="'+key+'"><strong>'+d+'</strong>'+(info?'<span>'+info.events+' event'+(info.events===1?'':'s')+'</span>':'')+'</button>');}const events=calendarDayData?.events||[],artifacts=calendarDayData?.artifacts||[],snapshots=calendarDayData?.snapshots||[];return vaultRecoveryNotice()+'<div class="page-heading"><div><div class="eyebrow">Vault & timeline</div><h1>Calendar</h1><p class="intro">A local, evidence-backed history of what happened, when it happened, and where the files live.</p></div><div class="actions">'+button('cal-prev','←','ghost')+button('cal-next','→','ghost')+button('vault-snapshot','Snapshot workspace','primary')+'</div></div><div class="vault-metrics"><div><strong>'+esc(vault.events||0)+'</strong><span>events</span></div><div><strong>'+esc(vault.artifacts||0)+'</strong><span>artifacts</span></div><div><strong>'+esc(vault.snapshots||0)+'</strong><span>snapshots</span></div></div><div class="calendar-layout"><section class="card calendar-card"><div class="calendar-title"><h2>'+esc(cursor.toLocaleDateString([],{month:'long',year:'numeric'}))+'</h2><span class="small-note">Local time</span></div><div class="cal-week"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="cal-grid">'+cells.join('')+'</div></section><section class="card day-card"><div class="calendar-title"><h2>'+esc(new Date(calendarSelected+'T12:00:00').toLocaleDateString([],{weekday:'long',day:'numeric',month:'long',year:'numeric'}))+'</h2><span class="tag">'+events.length+' EVENTS</span></div>'+(events.length?'<div class="timeline">'+events.map(e=>'<div class="timeline-item"><time>'+time(e.created_at)+'</time><div><div><span class="tag '+esc(e.state)+'">'+esc(e.state)+'</span> <strong>'+esc(e.project_name||'Workspace')+'</strong></div><p>'+esc(e.summary)+'</p>'+(e.path||e.cwd?'<code>'+esc(e.path||e.cwd)+'</code>':'')+'</div></div>').join('')+'</div>':'<div class="empty"><h3>No indexed work that day.</h3><p>Jobs will appear here automatically as PC Bridge records them.</p></div>')+(artifacts.length?'<div class="day-section"><h3>Files</h3>'+artifacts.map(a=>'<div class="vault-file"><span>'+esc(a.kind)+'</span><code>'+esc(a.path)+'</code>'+(a.sha256?'<small>SHA-256 '+esc(a.sha256.slice(0,16))+'…</small>':'')+'</div>').join('')+'</div>':'')+(snapshots.length?'<div class="day-section"><h3>Snapshots</h3>'+snapshots.map(s=>'<div class="vault-file"><span>'+esc(s.label)+'</span><code>'+esc(s.output_path||s.root||'')+'</code>'+(s.sha256?'<small>'+esc(s.sha256.slice(0,16))+'…</small>':'')+'</div>').join('')+'</div>':'')+'</section></div><p class="footer-note">Vault indexes metadata only. Files remain in their normal project locations; snapshots are additive evidence, not a replacement filesystem.</p>';}
function rows(jobs){return jobs.map(j=>{
  const blocker=j.state==='queued'&&!backgroundJob(j)?state.jobs.find(other=>other.id!==j.id&&!backgroundJob(other)&&other.state==='running'&&(other.lane_key??other.project_id)===(j.lane_key??j.project_id)):null;
  return '<div class="job-row"><span class="tag '+esc(j.state)+'">'+esc(j.state)+'</span><div class="job-info"><strong>'+esc(jobTitle(j))+'</strong><small>'+esc(j.project_name)+(['process','project_task'].includes(j.kind)&&j.pid?' · PID '+j.pid:'')+' · '+time(j.created_at)+(j.restored?' · Restored':'')+'</small>'+(blocker?'<small>Waiting for '+esc(jobTitle(blocker))+' · '+esc(blocker.id.slice(0,8))+' in this folder.</small>':'')+'</div>'+(backgroundJob(j)&&['pending','queued','running'].includes(j.state)?button('stop-job',j.state==='pending'?'Reject':'Stop','danger-outline','data-id="'+esc(j.id)+'"'):'')+button('review','View receipt','secondary','data-id="'+esc(j.id)+'"')+'</div>';
}).join('');}
function activity(){
  const jobs=[...state.jobs].reverse(),capacity=state.job_capacity||{},pending=jobs.filter(j=>j.state==='pending').length;
  const groups=[['Running work',jobs.filter(j=>j.state==='running'&&!backgroundJob(j))],['Waiting',jobs.filter(j=>['pending','queued'].includes(j.state))],['Background services',jobs.filter(j=>j.state==='running'&&backgroundJob(j))],['Finished',jobs.filter(j=>!['pending','queued','running'].includes(j.state))]];
  return '<div class="page-heading"><div><div class="eyebrow">Execution receipts and approvals</div><h1>See what happened.</h1><p class="intro">'+(pending?pending+' action'+(pending===1?' is':'s are')+' waiting for your approval.':'Inspect outputs, cancellations and backed-up file edits here.')+'</p></div>'+button('export','Save diagnostic report','ghost')+'</div>'+
    '<section class="card"><h2>Job limits</h2><p>'+esc(capacity.active_requests||0)+' active requests · '+esc(capacity.background_services||0)+' background-service slots in use (including waiting or stopping).</p><div class="actions"><label>Active requests (running + waiting)<input id="active-limit" type="number" min="1" max="64" step="1" value="'+esc(draft.activeLimit??capacity.max_active_requests??20)+'"></label><label>Background services<input id="background-limit" type="number" min="0" max="8" step="1" value="'+esc(draft.backgroundLimit??capacity.max_background_services??2)+'"></label>'+button('save-job-limits','Save limits','secondary')+'</div><p class="small-note">Different project roots can run together. Ordinary work in one root stays ordered. Background viewers/servers require your approval before running alongside edits. Limits apply to new requests; saving them does not stop current work. Set background services to 0 to block new requests.</p></section>'+
    '<div class="tip">'+state.receipts+' receipt events. Pending means nothing has executed yet. File-tool replacements receive backups; arbitrary command edits do not.</div>'+
    groups.map(([title,items])=>'<section><h2>'+title+' ('+items.length+')</h2>'+(items.length?'<div class="list">'+rows(items)+'</div>':'<p class="small-note">None.</p>')+'</section>').join('');
}
async function review(id){
  const dialog=document.querySelector('#review'),request=++reviewRequest;
  if(reviewId!==id||!dialog.open){
    reviewId=id;
    document.querySelector('#review-content').innerHTML='<div class="review-title"><h2>Action receipt</h2>'+button('close-review','Close','ghost')+'</div><p>Loading receipt…</p>';
    if(!dialog.open)dialog.showModal();
  }
  let j;try{j=await call('jobDetail',{id});}catch{return;}
  if(request!==reviewRequest||reviewId!==id||!dialog.open)return;
  document.querySelector('#review-content').innerHTML='<div class="review-title"><div><div class="eyebrow">'+esc(j.project_name)+'</div><h2>Action receipt</h2><span class="tag">'+esc(j.state)+'</span></div>'+button('close-review','Close','ghost')+'</div>'+
  (j.kind==='write'?'<p class="project-path">'+esc(j.path)+'</p><div class="review-columns"><div><h3>BEFORE</h3><pre>'+esc(j.before??'(New file)')+'</pre></div><div><h3>SUBMITTED TEXT</h3><pre class="after">'+esc(j.content)+'</pre></div></div>':'<pre>'+esc(j.command||j.task)+'</pre>')+
  (backgroundJob(j)?'<div class="tip amber"><strong>'+esc(j.service_name)+'</strong><br>Working folder: '+esc(j.cwd)+'<br>Maximum runtime: '+esc(j.max_runtime_seconds)+' seconds. Runs alongside ordinary work as your Windows user, NOT in a sandbox. Only approve a service you trust to run alongside file edits.</div>':'')+
  (j.kind==='process'&&(j.stdout_tail||j.stderr_tail)?'<h3>Live managed output · untrusted data</h3><pre class="result">'+esc((j.stdout_tail||'')+(j.stderr_tail?'\n[stderr]\n'+j.stderr_tail:''))+'</pre>':'')+(j.result?'<h3>Actual result</h3><pre class="result">'+esc(JSON.stringify(j.result,null,2))+'</pre>':'')+(j.error?'<div class="callout error">'+esc(j.error)+'</div>':'')+
  '<div class="actions">'+(j.state==='pending'?button('approve','Approve & run','primary')+button('reject','Reject','danger-outline'):['queued','running'].includes(j.state)?button('reject','Cancel job','danger-outline'):'')+(j.kind==='write'&&j.before!==null&&j.state==='succeeded'&&!j.restored?button('restore','Restore previous text','secondary'):'')+'</div><p class="footer-note">Request '+esc(j.id)+'<br>Receipt '+esc(j.receipt_hash||'Not finished yet')+'</p>';
}
document.querySelector('#review').addEventListener('close',()=>{reviewId=null;reviewRequest++;document.querySelector('#review-content').replaceChildren();});
document.addEventListener('click',async event=>{
  const page=event.target.closest('[data-page]');if(page){if(page.dataset.page!=='siri'){siriPairing=null;siriPhoneResult=null;}current=page.dataset.page;render();if(current==='calendar')void loadCalendar();return;}
  const el=event.target.closest('[data-action]');if(!el||busy)return;
  const action=el.dataset.action,id=el.dataset.id,mode=el.dataset.mode,taskId=el.dataset.taskId,clientId=el.dataset.clientId;
  try{
    if(action==='siri-phone-back'){siriPhoneResult=null;render();return;}
    if(action==='go-connect'){current='connect';render();return;}
    if(action==='cal-prev'){calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()-1,1);calendarSelected=dateKey(calendarCursor);calendarMonthData=null;calendarDayData=null;render();void loadCalendar();return;}
    if(action==='cal-next'){calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()+1,1);calendarSelected=dateKey(calendarCursor);calendarMonthData=null;calendarDayData=null;render();void loadCalendar();return;}
    if(action==='cal-day'){calendarSelected=el.dataset.day;calendarDayData=null;render();void loadCalendar();return;}
    if(action==='review'){review(id);return;}
    if(action==='close-review'){document.querySelector('#review').close();return;}
    busy=true;el.disabled=true;
    if(action.startsWith('link-'))await call('openLink',{id:action.slice(5)});
    else if(action==='save-connection'){const result=await call('saveConnection',{tunnelId:document.querySelector('#tunnel-id').value.trim(),key:document.querySelector('#runtime-key').value.trim()});if(result.saved){draft.key='';document.querySelector('#runtime-key').value='';toast('Saved. Connecting…');}}
    else if(action==='work-session-toggle'){await call('workSessionSetting',{enabled:!state.work_sessions?.enabled});toast('Work-clock setting saved. No global access settings changed.');}
    else if(action==='work-session-resume'){await call('workSessionResume',{id,period:Number(el.dataset.period)});toast('Message timer started. New phone messages normally start their own timer.');}
    else if(action==='connect')await call('connect');
    else if(action==='disconnect')await call('disconnect');
    else if(action==='claude-connect'){await call('ensureClaudeClient');await call('remoteConnect');toast('Creating and verifying Claude MCP endpoint...');}
    else if(action==='remote-connect'){await call('remoteConnect');toast('Creating persistent remote MCP endpoint...');}
    else if(action==='remote-disconnect'){await call('remoteDisconnect');toast('Temporary remote MCP endpoint stopped.');}
    else if(action==='siri-run'){const result=await call('siriPerform',{action:el.dataset.siriAction});siriPhoneResult={title:el.getAttribute('aria-label')||'Windows action',message:result.message};toast(result.message);}
    else if(action==='siri-open-music'){const result=await call('siriPerform',{action:'open_apple_music'});siriPhoneResult={title:'Apple Music',message:result.message};toast(result.message);}
    else if(action==='siri-google-search'){const result=await call('siriPerform',{action:'search_google',query:siriGoogleDraft});siriPhoneResult={title:'Google search',message:result.message};toast(result.message);}
    else if(action==='siri-show-activity'){siriPhoneResult={title:'Activity',message:'Recent activity is on the phone home screen. Open the main Activity or Calendar page for complete records.'};render();return;}
    else if(action==='siri-start'){await call('siriStart');siriPairing=null;toast('Siri endpoint started on your private network.');}
    else if(action==='siri-stop'){await call('siriStop');siriPairing=null;toast('Siri connection stopped.');}
    else if(action==='siri-rotate'){const result=await call('siriRotate');if(!result?.cancelled){siriPairing=null;toast('Old Siri pairing revoked.');}}
    else if(action==='siri-pairing'){siriPairing=await call('siriPairing');}
    else if(action==='siri-choose-evidence'){const result=await call('siriChooseEvidence');toast(result?.cancelled?'No change to evidence folder.':'Saved build evidence folder.');}
    else if(action==='siri-copy-setup'){const p=await call('siriPairing');const txt='Apple Shortcuts: name the shortcut Control My PC. Use Ask for Input (Text), then Get Contents of URL at '+p.address+' using POST. Add HTTP header x-siri-key: '+p.token+'. Use JSON request body with key request and Ask for Input as its value. Finish with Speak Text reading Get Contents of URL. This is a private pairing key: do not share it.';await call('copy',{text:txt});toast('Setup instructions copied to this PC clipboard.');}
    else if(action==='client-create'){const label=document.querySelector('#client-label')?.value.trim(),provider=document.querySelector('#client-provider')?.value;await call('clientCreate',{label,provider});draft.clientLabel='';draft.clientProvider='anthropic-claude';toast('AI client added at Read only.');}
    else if(action==='client-select-remote'){await call('clientSelectRemote',{id:clientId});toast('Remote endpoint client selected.');}
    else if(action==='client-remove'){await call('clientRemove',{id:clientId});toast('AI client removed and its active jobs revoked.');}
    else if(action==='set-mode'){const result=await call('setAccessMode',{mode});toast(result?.cancelled?'Full access unchanged.':'Access mode: '+modeName(mode)+'.');}
    else if(action==='enable'){const result=await call('enable',{mode:state.access_mode});toast(result?.cancelled?'Access remains paused.':modeName(state.access_mode)+' enabled.');}
    else if(action==='demo'){await call('demo');toast('Practice project ready.');}
    else if(action==='add-project')await call('chooseProject');
    else if(action==='create-project'){const result=await call('createProject');if(result?.created)toast('Workspace created and made active.');}
    else if(action==='set-default'){await call('setDefaultProject',{id});toast('Active workspace changed.');}
    else if(action==='git-checkpoint'){const cp=await call('gitCheckpoint',{id:state.default_project_id});toast('Checkpoint created: '+String(cp.commit||'').slice(0,10));}
    else if(action==='git-rollback'){const r=await call('gitRollback',{id});if(!r?.cancelled)toast('Tracked files rolled back to checkpoint.');}
    else if(action==='vault-snapshot'){const snap=await call('vaultSnapshot',{id:state.default_project_id,label:'PC Bridge workspace snapshot'});toast('Snapshot saved: '+String(snap.sha256||'').slice(0,12)+'…');calendarDayData=null;calendarMonthData=null;}
    else if(action==='choose-test')await call('chooseTest',{id});
    else if(action==='choose-project-task')await call('chooseProjectTask',{id});
    else if(action==='reapprove-project-task')await call('reapproveProjectTask',{id,taskId});
    else if(action==='revoke-project-task')await call('revokeProjectTask',{id,taskId});
    else if(action==='unshare')await call('removeProject',{id});
    else if(action==='open-project')await call('openProject',{id});
    else if(action==='export')await call('exportReport');
    else if(action.startsWith('copy-')){const text=action==='copy-tunnel'?state.connection.tunnel_id:action==='copy-remote-url'?state.remote_connection?.mcp_url:prompts()[action.slice(5)];if(!text)throw Error(action==='copy-remote-url'?'Start the temporary endpoint first.':'Save the connection first.');await call('copy',{text});toast('Copied.');}
    else if(action==='save-job-limits'){await call('setJobLimits',{max_active_requests:Number(document.querySelector('#active-limit').value),max_background_services:Number(document.querySelector('#background-limit').value)});draft.activeLimit=null;draft.backgroundLimit=null;toast('Limits saved. Existing jobs were left running.');}
    else if(action==='stop-job'){await call('reject',{id});toast('Stopping this background service only.');}
    else if(action==='approve'){const result=await call('approve',{id:reviewId});if(!result?.cancelled){document.querySelector('#review').close();toast('Approved. PC Bridge may run that exact action now.');}}
    else if(action==='reject'){await call('reject',{id:reviewId});document.querySelector('#review').close();}
    else if(action==='restore'){await call('restore',{id:reviewId});document.querySelector('#review').close();}
    state=await call('state');render();
  }catch(error){
    if(action==='siri-open-music'||(action==='siri-run'&&el.dataset.siriAction==='open_apple_music')){
      toast('Apple Music could not open. Check Siri permissions and the Windows app.');
    }
  }finally{busy=false;el.disabled=false;}
});
document.addEventListener('change',async event=>{if(event.target?.id==='rail-workspace'){try{await call('setDefaultProject',{id:event.target.value});state=await call('state');render();toast('Active workspace changed.');}catch{}}else if(event.target?.classList?.contains('client-ceiling')){try{const result=await call('clientSetCeiling',{id:event.target.dataset.clientId,mode:event.target.value});state=await call('state');render();toast(result?.cancelled?'AI client ceiling unchanged.':'AI client ceiling updated locally.');}catch{state=await call('state');render();}}});
document.querySelector('#sync-chat').addEventListener('click',async()=>{const el=document.querySelector('#sync-chat');try{el.disabled=true;const result=await call('chatReload',{force:true});toast(result?.reloaded?'Chat synced.':'Chat is still loading.');}catch{}finally{el.disabled=false;}});
document.querySelector('#pause-top').addEventListener('click',async()=>{try{await call('pause');state=await call('state');render();toast('Access paused. Active jobs cancelled.');}catch{}});
let refreshInFlight=null,refreshAgain=false;
async function refreshFromBridge(){
  if(refreshInFlight){refreshAgain=true;return refreshInFlight;}
  refreshInFlight=(async()=>{do{
    refreshAgain=false;
    state=await call('state');renderAccessChrome();
    if(clientControlActive()){deferredBridgeRefresh=true;continue;}
    render();if(current==='calendar')void loadCalendar();
    if(document.querySelector('#review').open)void review(reviewId);
  }while(refreshAgain);})();
  try{await refreshInFlight;}finally{refreshInFlight=null;}
}
function queueBridgeRefresh(delay=120){clearTimeout(render.timer);render.timer=setTimeout(()=>{deferredBridgeRefresh=false;void refreshFromBridge().catch(()=>{});},delay);}
document.addEventListener('focusout',()=>{if(!deferredBridgeRefresh)return;setTimeout(()=>{if(!clientControlActive()){deferredBridgeRefresh=false;queueBridgeRefresh(0);}},0);});
window.bridge.onChange(()=>queueBridgeRefresh());
document.addEventListener('input',event=>{if(event.target?.id==='siri-google-query')siriGoogleDraft=event.target.value;else if(event.target?.id==='active-limit')draft.activeLimit=event.target.value;else if(event.target?.id==='background-limit')draft.backgroundLimit=event.target.value;});
state=await call('state');render();

function workSessions(){
  const clocks=state.work_sessions||{enabled:true,sessions:[]};
  const labels={awaiting_message:'Ready — no chat lock',working:'Working on this message',wrap_up:'Wrapping up this message',checkpoint_due:'Save handover now',report_due:'This message is due to report',yielded:'Reply finished — ready for next message',disabled:'Clock disabled'};
  return '<div class="eyebrow">Timeout cushion</div><h1>Chat work clocks</h1><p class="intro">A fresh 25 minutes for each new message you send, including another “go” or “next stage”. Calls and reconnects within the same reply keep its original deadline. No manual chat unlock is needed.</p><div class="card"><div class="actions">'+button('work-session-toggle',clocks.enabled?'Turn clocks off':'Turn clocks on',clocks.enabled?'secondary':'primary')+'</div><p class="small-note">The agent marks each new reply; Bridge cannot directly see your phone message. At 20 minutes it asks the agent to wrap up, at 23 to save a handover, and at 25 to report back. Only calls explicitly marked as that expired reply are held. Without a message marker, advice is given but no old chat timer blocks work. Timing starts at Bridge contact, not phone send time. Accepted jobs are not killed. This cannot force a reply or prevent every timeout. Handovers preserve notes and receipts, not unsent edits or full backups. Access permissions are unchanged.</p></div>'+
    (clocks.sessions.length?clocks.sessions.map(s=>{const note=s.checkpoint?.agent_reported_not_independently_verified;return '<section class="card work-clock"><div class="section-title"><h2>'+esc(s.label)+' · '+esc(s.work_session_id.slice(0,6))+'</h2><span class="tag">'+esc(labels[s.phase]||s.phase)+'</span></div><p><strong data-work-deadline="'+esc(s.deadline_at||'')+'" data-work-phase="'+esc(s.phase)+'">'+(s.remaining_seconds===null?'Waiting for a message marker — not locked':esc(s.remaining_seconds)+' seconds remaining')+'</strong> · message period '+esc(s.period)+' · '+(s.identity==='provider_session'?'Chat identifier received':'Explicit session token')+'</p><p class="small-note">Last contact '+time(s.last_seen_at)+(s.started_at?' · message started '+time(s.started_at):'')+'</p>'+(note?'<details><summary>Saved handover · '+time(s.checkpoint.at)+'</summary><p class="small-note">Agent-reported notes. Only the attached job receipts are observed evidence.</p>'+Object.entries(note).map(([k,v])=>'<h3>'+esc(k.replaceAll('_',' '))+'</h3><pre class="handover-note">'+esc(v)+'</pre>').join('')+'</details>':'<p class="small-note">No agent handover saved yet. Recent tool activity is retained locally.</p>')+(['report_due','yielded','awaiting_message'].includes(s.phase)?button('work-session-resume','Start message timer manually','secondary','data-id="'+esc(s.work_session_id)+'" data-period="'+s.period+'"'):'')+'</section>';}).join(''):'<div class="empty"><h3>No identified chats yet.</h3><p>Bridge asks the agent to identify its chat and start a fresh timer on each new user message. You do not need to set one up here.</p></div>');
}
function updateWorkClockLabels(){
  if(current!=='workSessions')return;
  for(const el of document.querySelectorAll('[data-work-deadline]')){
    const phase=el.dataset.workPhase;
    const seconds=Math.max(0,Math.ceil((Date.parse(el.dataset.workDeadline)-Date.now())/1000));
    el.textContent=phase==='awaiting_message'?'Waiting for a message marker — not locked':phase==='yielded'?'Ready for your next message':phase==='disabled'?'Clock disabled':seconds?Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+' remaining':'Time to save and report back';
  }
}
setInterval(updateWorkClockLabels,1000);
setInterval(()=>{if(current==='workSessions'&&!busy)void refreshFromBridge().catch(()=>{});},5000);

function renderAccessChrome(){
  const view=accessPresentation(state),label=document.querySelector('#access-label');
  label.textContent=view.label;label.title=view.detail;label.dataset.protectionState=view.state;
  label.classList.toggle('chaff-restricted',view.restricted);
}
function protectedAccessHome(){
  const view=accessPresentation(state);
  return '<div class="eyebrow">Chaff · effective access</div><h1>Your AI. Your computer.</h1>'+
    '<section class="card chaff-access-card" data-protection-state="'+esc(view.state)+'"><span class="tag">'+(view.state==='unavailable'?'CHECK LOCALLY':'HOST ACCESS BLOCKED')+'</span>'+
    '<h2>'+esc(view.label)+'</h2><p>'+esc(view.detail)+'</p>'+
    '<p class="small-note">This protection covers this Bridge connection, not other apps or connectors.</p></section>'+
    '<section class="card"><h3>Saved ordinary mode: '+esc(view.savedMode)+'</h3><p>This saved setting is not the current effective permission. It does not override Chaff.</p>'+
    '<p>Use the Protected Tasks controls in Chaff. Leaving protection keeps ordinary access paused; only your local action can restore it.</p></section>'+
    '<p class="footer-note">No files are applied to your project automatically. Changing this display does not change permissions.</p>';
}
