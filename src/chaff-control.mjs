// PC Bridge-side authenticated OWNER control. No remote-agent permission tools.
import http from 'node:http';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { lstat, writeFile, rename, readFile, unlink } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = new Set(['pending', 'queued', 'running']);
const KINDS = new Set(['command', 'process', 'project_task', 'test']);
const sha = text => createHash('sha256').update(text).digest('hex');
const identity = j => sha(JSON.stringify([j.id, j.kind, j.project_id, j.created_at, j.signature]));
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startChaffControl({ core, dataDir, ticketMs = 30000 }) {
  const discovery = path.join(dataDir, 'chaff-control.json');
  for (let p = path.resolve(dataDir); ; p = path.dirname(p)) {
    if ((await lstat(p)).isSymbolicLink()) throw Error('Linked control directory refused');
    if (path.dirname(p) === p) break;
  }
  try { const s = await lstat(discovery); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw Error('Linked control record refused'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const token = randomBytes(32).toString('hex');
  const instance = core.instance;
  if (!UUID.test(instance)) throw Error('Invalid Bridge instance');
  const tickets = new Map();
  const requested = new Set();
  let port, inflight = 0, closed = false;
  function accessView() {
    if (typeof core.checkAccess !== 'function' || typeof core.pause !== 'function') throw Error('Access control unavailable');
    let enabled = true;
    try { core.checkAccess(); } catch { enabled = false; }
    const active = core.jobs.filter(j => ACTIVE.has(j.state)).length;
    const executing = new Set([...core.executions.keys(), ...core.controllers.keys()]).size;
    return {version:1, instance, scope:'all_bridge', access_enabled:enabled,
      held:!enabled, active_jobs:active, executing_jobs:executing,
      jobs_ended:active === 0 && executing === 0, resume_location:'PC Bridge desktop'};
  }
  function accessIdentity() {
    return sha(JSON.stringify([instance, 'all_bridge', core.trustedAccess, core.leaseUntil, core.accessMode]));
  }
  function job(id) {
    if (!UUID.test(id)) throw Error('Invalid job identity');
    const j = core.jobs.find(j => j.id === id);
    if (!j || !KINDS.has(j.kind)) throw Error('Supported Bridge task not found');
    return j;
  }
  function inspect(j) {
    const busy = core.executions.has(j.id) || core.controllers.has(j.id);
    // A cancellation receipt alone is NOT confirmation that execution ended.
    const stopped = requested.has(j.id) && j.state === 'cancelled' && !busy;
    return {
      version: 1, instance, id: j.id, identity: identity(j), kind: j.kind,
      project_id: UUID.test(j.project_id || '') ? j.project_id : null,
      actor: ({openai:'ChatGPT', 'anthropic-claude':'Claude'})[j.source_provider] || 'Remote agent',
      state: String(j.state), execution_active: Boolean(busy),
      can_stop: ACTIVE.has(j.state), stop_requested: requested.has(j.id), stopped,
      completion: stopped ? 'bridge_execution_ended' : null,
    };
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Connection':'close'});
      res.end(JSON.stringify(value));
    };
    if (closed || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined ||
        req.method !== 'POST' || req.headers['content-type'] !== 'application/json' ||
        !equal(req.headers.authorization, `Bearer ${token}`)) {
      reply(403, {error:'local_control_refused'}); req.resume(); return;
    }
    const protectedAction = /^\/v1\/(?:prepare-)?protected-(?:status|select|start|stop|leave|return|check)$/.test(req.url);
    if ((!protectedAction && !['/v1/inspect','/v1/prepare-stop','/v1/stop','/v1/access-status','/v1/prepare-pause','/v1/pause'].includes(req.url)) || inflight >= 4) {
      reply(429, {error:'control_request_refused'}); req.resume(); return;
    }
    inflight++;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw Error('size'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const [key, t] of tickets) if (t.expires < Date.now()) tickets.delete(key);
      if (protectedAction) {
        const manager=core.chaffProtected;
        if(!manager)throw Error('Protected route unavailable');
        const action=req.url.slice(4), preparing=action.startsWith('prepare-');
        const operation=action.replace('prepare-','');
        if(operation==='protected-select'&&!preparing){
          if(!value||value.instance!==instance||value.scope!=='protected_bridge'||Object.keys(value).sort().join()!=='instance,path,scope,sha256')throw Error('selection shape');
          manager.select(value.path,value.sha256);
          reply(200,{...manager.ownerStatus(),instance,scope:'protected_bridge'});return;
        }
        const fields=preparing||operation==='protected-status'?['instance','scope']:['instance','scope','identity','ticket'];
        if(!value||Array.isArray(value)||value.instance!==instance||value.scope!=='protected_bridge'||Object.keys(value).sort().join()!==fields.sort().join())throw Error('protected shape');
        const view=()=>manager.ownerStatus?manager.ownerStatus():manager.status();
        const binding=sha(JSON.stringify([instance,view()]));
        if(preparing){
          if(['protected-status','protected-select'].includes(operation)||tickets.size>=64)throw Error('protected action');
          const ticket=randomBytes(32).toString('hex');
          tickets.set(ticket,{action:operation,identity:binding,expires:Date.now()+ticketMs});
          reply(200,{...view(),instance,scope:'protected_bridge',identity:binding,ticket});return;
        }
        if(operation!=='protected-status'){
          const t=tickets.get(value.ticket);tickets.delete(value.ticket);
          if(!t||t.action!==operation||t.identity!==value.identity||t.identity!==binding||t.expires<Date.now())throw Error('stale protected confirmation');
          req.socket.setTimeout(10000);
          if(operation==='protected-start')manager.start();
          else if(operation==='protected-stop')await manager.stop();
          else if(operation==='protected-leave')await manager.leave();
          else if(operation==='protected-return')await manager.leave({resume:true});
          else if(operation==='protected-check')manager.check();
          else throw Error('protected operation');
          await core.serial(()=>core.receipt('chaff_protected_control',{action:operation,state:manager.state}));
        }
        reply(200,{...view(),instance,scope:'protected_bridge'});return;
      }
      if (['/v1/access-status','/v1/prepare-pause','/v1/pause'].includes(req.url)) {
        const fields = req.url === '/v1/pause' ? ['instance','scope','identity','ticket'] : ['instance','scope'];
        if (!value || Array.isArray(value) || value.instance !== instance || value.scope !== 'all_bridge' || Object.keys(value).sort().join() !== fields.sort().join()) throw Error('access shape');
        if (req.url === '/v1/prepare-pause') {
          if (tickets.size >= 64) throw Error('ticket capacity');
          const ticket = randomBytes(32).toString('hex'), binding = accessIdentity();
          tickets.set(ticket, {action:'pause', identity:binding, expires:Date.now()+ticketMs});
          reply(200, {...accessView(), identity:binding, ticket}); return;
        }
        if (req.url === '/v1/pause') {
          const t = tickets.get(value.ticket); tickets.delete(value.ticket);
          if (!t || t.action !== 'pause' || t.identity !== value.identity || t.identity !== accessIdentity() || t.expires < Date.now()) throw Error('stale pause confirmation');
          // Existing Bridge revocation closes admission synchronously, aborts all
          // managed controllers, cancels queued work and persists paused access.
          // New jobs arriving after confirmation are deliberately inside ALL scope.
          await core.pause();
        }
        reply(200, accessView()); return;
      }
      if (!value || Array.isArray(value) || value.instance !== instance || !UUID.test(value.id || '')) throw Error('shape');
      const fields = req.url === '/v1/stop' ? ['instance','id','identity','ticket'] : ['instance','id'];
      if (Object.keys(value).sort().join() !== fields.sort().join()) throw Error('fields');
      const j = job(value.id);
      if (req.url === '/v1/prepare-stop') {
        const view = inspect(j);
        if (!view.can_stop) { reply(200, {...view, ticket:null}); return; }
        if (tickets.size >= 64) throw Error('ticket capacity');
        const ticket = randomBytes(32).toString('hex');
        tickets.set(ticket, {id:j.id, identity:identity(j), expires:Date.now() + ticketMs});
        reply(200, {...view, ticket}); return;
      }
      if (req.url === '/v1/stop') {
        const t = tickets.get(value.ticket);
        tickets.delete(value.ticket); // Single use, even when stale or mismatched.
        if (!t || t.id !== j.id || t.identity !== value.identity || identity(j) !== t.identity || t.expires < Date.now()) throw Error('stale confirmation');
        if (ACTIVE.has(j.state)) {
          if (requested.size >= 512) throw Error('stop history capacity');
          requested.add(j.id);
          try { await core.cancel(j.id); }
          catch (e) { requested.delete(j.id); throw e; }
        }
      }
      reply(200, inspect(j));
    } catch {
      reply(409, {error:'task_changed_or_control_unavailable'});
    } finally { inflight--; }
  });
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.timeout = 3500;
  server.keepAliveTimeout = 1; server.maxHeadersCount = 20;
  server.on('clientError', (_e, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const record = {version:1, port, pid:process.pid, instance, token};
  const temporary = discovery + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { await writeFile(temporary, JSON.stringify(record), {flag:'wx', mode:0o600}); await rename(temporary, discovery); }
  catch (e) { server.closeAllConnections(); server.close(); try { await unlink(temporary); } catch {} throw e; }
  return {
    async close() {
      if (closed) return; closed = true; tickets.clear(); requested.clear();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      try { if (JSON.parse(await readFile(discovery, 'utf8')).instance === instance) await unlink(discovery); } catch {}
    },
  };
}
