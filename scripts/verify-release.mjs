import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const expectedTunnelSha='fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b';
const forbiddenNames=new Set([
  'connection.json','remote-connection.json','workspace-state.json','ai-clients.json',
  'smoke-result.json','tunnel-key.encrypted','remote-tunnel-guest.encrypted'
]);
const textExt=new Set(['.md','.txt','.json','.js','.mjs','.cjs','.yml','.yaml','.html','.css','.gitignore','.gitattributes']);
const secretPatterns=[
  {name:'OpenAI runtime key',re:/\bsk-[A-Za-z0-9_-]{20,}\b/g},
  {name:'real OpenAI tunnel id',re:/\btunnel_[0-9a-f]{32}\b/g},
  {name:'persistent MCP capability URL',re:/https:\/\/[^\s"'<>]+\/mcp\/[0-9a-f]{64}\b/gi},
  {name:'personal Windows profile path',re:/[A-Z]:\\Users\\ollet\\/gi}
];
const allowedDirs=new Set(['.git','node_modules']);

async function walk(dir){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(allowedDirs.has(entry.name))continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const failures=[];
const files=await walk(root);
for(const file of files){
  const name=path.basename(file);
  if(forbiddenNames.has(name)||name.endsWith('.encrypted'))failures.push('forbidden local-state file: '+path.relative(root,file));
  const ext=path.extname(file).toLowerCase();
  if(textExt.has(ext)||name==='.gitignore'||name==='.gitattributes'){
    const s=await readFile(file,'utf8');
    for(const p of secretPatterns){
      const matches=[...s.matchAll(p.re)];
      if(matches.length)failures.push(p.name+' in '+path.relative(root,file));
      p.re.lastIndex=0;
    }
  }
}

const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(pkg.license!=='Apache-2.0')failures.push('package.json license is not Apache-2.0');
if(pkg.version!=='0.5.16')failures.push('unexpected package version '+pkg.version);

const tunnel=await readFile(path.join(root,'vendor','tunnel-client.exe'));
const actual=createHash('sha256').update(tunnel).digest('hex');
if(actual!==expectedTunnelSha)failures.push('vendor/tunnel-client.exe hash mismatch');

for(const required of [
  'LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','SECURITY.md',
  'docs/media/PC-Bridge-Setup-and-First-Test.mp4',
  'vendor/LICENSE-tunnel.txt','vendor/NOTICE-tunnel.txt','vendor/tunnel-client.spdx.json'
]){
  try{await stat(path.join(root,required));}catch{failures.push('missing required release file: '+required);}
}

if(failures.length){
  console.error('Release verification FAILED');
  for(const f of failures)console.error('- '+f);
  process.exit(1);
}
console.log('Release verification PASS');
console.log('Files scanned: '+files.length);
console.log('OpenAI tunnel-client SHA-256: '+actual);
