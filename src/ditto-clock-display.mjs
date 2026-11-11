// Read-only, owner-local display transport. No MCP calls or session mutations.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';

const digest = value => createHash('sha256').update(String(value)).digest('hex');
const equal = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function startClockDisplay({workSessions,dataDir,isProtected=()=>false,now=Date.now}) {
  await workSessions.ready;
  const file=path.join(dataDir,'ditto-clock-display.json'),instance=randomUUID(),token=randomBytes(32).toString('hex');
  let port,closed=false;
  const server=http.createServer((req,res)=>{
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    if(closed || req.socket.remoteAddress!=='127.0.0.1' || req.headers.host!==`127.0.0.1:${port}` || req.headers.origin!==undefined || req.method!=='GET' || req.url!=='/v1/reply-clocks' || req.headers['transfer-encoding'] || Number(req.headers['content-length']||0)!==0 || !equal(req.headers.authorization,`Bearer ${token}`)) {req.resume();return reply(403,{error:'display_request_refused'});}
    try {
      const protectedMode=isProtected(),snapshot=protectedMode?null:workSessions.snapshot();
      const sessions=(snapshot?.sessions||[]).slice(0,64).map(row=>({
        // Neither the provider ID nor the explicit session token leaves Bridge.
        display_id:digest(row.work_session_id),reply_id:row.work_turn_id?digest(row.work_turn_id):null,
        period:row.period,phase:row.phase,started_at:row.started_at,deadline_at:row.deadline_at,
        remaining_seconds:row.remaining_seconds,last_seen_at:row.last_seen_at,
        checkpoint:row.checkpoint?{at:row.checkpoint.at,period:row.checkpoint.period}:null,
        turn_identity_source:row.turn_identity_source,
      }));
      reply(200,{protocol:'ditto-reply-clocks-v1',instance,pid:process.pid,server_time:new Date(now()).toISOString(),
        protected:protectedMode,enabled:snapshot?.enabled??false,timing_minutes:snapshot?.timing_minutes??[20,23,25],sessions});
    } catch {reply(503,{error:'clock_display_unavailable'});}
  });
  server.requestTimeout=2000;server.headersTimeout=2000;server.timeout=2000;server.keepAliveTimeout=1;server.maxHeadersCount=20;
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  port=server.address().port;
  const temp=file+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temp,JSON.stringify({protocol:'ditto-reply-clocks-v1',instance,pid:process.pid,port,token}),{flag:'wx',mode:0o600});
    await fs.rename(temp,file);
  } catch(error) {server.closeAllConnections();await new Promise(r=>server.close(r));await fs.unlink(temp).catch(()=>{});throw error;}
  return {async close(){
    if(closed)return;closed=true;server.closeAllConnections();await new Promise(r=>server.close(r));
    try{if(JSON.parse(await fs.readFile(file,'utf8')).instance===instance)await fs.unlink(file);}catch{}
  }};
}
