import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../src/app.mjs';

const root = resolve(import.meta.dirname,'..');
await mkdir(resolve(root,'.local'),{recursive:true});
const port = Number(process.env.PORT || 3000);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
let ownerCode = process.env.OWNER_ACCESS_CODE;
if (!ownerCode) {
 try { ownerCode = (await readFile(resolve(root,'.local/owner-access-code.txt'),'utf8')).trim(); }
 catch { throw new Error('Set OWNER_ACCESS_CODE before starting; do not use a default password.'); }
}
const assets = await Promise.all(['src/ui.html','src/ui.css','src/ui.js','relay.py','INTEGRATION.md','EM_SKILL.md'].map(file=>readFile(resolve(root,file),'utf8')));
const db = new DatabaseSync(process.env.DATABASE_PATH || resolve(root,'.local/relay.sqlite'));
const app = createApp({db,origin,ownerCode,html:assets[0],css:assets[1],js:assets[2],cli:assets[3],integration:assets[4],emSkill:assets[5]});
const server=createServer(async (req,res)=> {
 try {
  const requestHeaders=new Headers();
  for (const [key,value] of Object.entries(req.headers)) if(value!==undefined) requestHeaders.set(key,Array.isArray(value)?value.join(','):value);
  const options={method:req.method,headers:requestHeaders};
  if(!['GET','HEAD'].includes(req.method)) { options.body=req; options.duplex='half'; }
  // Use configured origin, never untrusted Host headers.
  const result=await app.fetch(new Request(new URL(req.url,origin),options));
  res.writeHead(result.status,Object.fromEntries(result.headers));
  if(result.body) for await(const chunk of result.body) res.write(chunk);
  res.end();
 } catch(error) {
  res.writeHead(503,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'service_unavailable',message:'The relay is temporarily unavailable.'}));
 }
});
server.listen(port,'127.0.0.1',()=>console.log(`Relay listening at ${origin}`));
function stop() { server.close(()=>{db.close();process.exit(0);}); }
process.on('SIGINT',stop); process.on('SIGTERM',stop);
