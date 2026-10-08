import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../src/app.mjs';

const ORIGIN='http://localhost:3000', OWNER='doorbell-owner-secret-code', ROOM='/api/rooms/elle-em';

function fixture(t, doorbell=null) {
 const dir=mkdtempSync(join(tmpdir(),'relay-doorbell-')),path=join(dir,'room.sqlite');
 let delivery=doorbell,db=new DatabaseSync(path),app=createApp({db,origin:ORIGIN,ownerCode:OWNER,doorbell:delivery});
 t.after(async()=>{await app.flushDoorbells();db.close();rmSync(dir,{recursive:true,force:true});});
 return {
  get db(){return db;},get app(){return app;},path,
  async request(path,options={}) {
   const {method='GET',body,token,cookie}=options,headers={};
   if(token)headers.Authorization='Bearer '+token;if(cookie)headers.Cookie=cookie;
   if(body!==undefined)headers['Content-Type']='application/json';
   return app.fetch(new Request(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}));
  },
  async restart(nextDoorbell=delivery) {await app.flushDoorbells();db.close();db=new DatabaseSync(path);delivery=nextDoorbell;app=createApp({db,origin:ORIGIN,ownerCode:OWNER,doorbell:delivery});},
  async setup() {
   const login=await this.request('/api/login',{method:'POST',body:{access_code:OWNER}});
   const cookie=login.headers.get('set-cookie').split(';')[0],result={cookie};
   for(const participant of ['elle','em'])result[participant]=(await data(await this.request('/api/keys',{method:'POST',cookie,body:{participant}}))).token;
   if(delivery)await data(await this.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:true}}));
   return result;
  }
 };
}
async function data(response,status=200) {const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
async function send(f,auth,content='A private test message',recipient='all',client_message_id=randomUUID()) {
 return data(await f.request(ROOM+'/messages',{method:'POST',...auth,body:{content,recipient,client_message_id}}),201);
}
async function ack(f,auth,through_seq) {return data(await f.request(ROOM+'/messages',{method:'POST',...auth,body:{type:'ack',through_seq}}));}
async function mcp(f,token,name,input) {
 const rpc=await data(await f.request('/mcp',{method:'POST',token,body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}}}));
 assert.equal(rpc.result.isError,false,JSON.stringify(rpc));return JSON.parse(rpc.result.content[0].text);
}

test('handled cursors are personal, durable, monotonic and create neither events nor turns',async t=> {
 const f=fixture(t),{cookie,elle,em}=await f.setup();
 await send(f,{token:em});const second=await send(f,{token:em});
 const initial=await data(await f.request(ROOM+'/inbox',{token:elle}));assert.equal(initial.handled_cursor,0);
 assert.equal((await ack(f,{token:elle},second.message.seq)).handled_cursor,2);
 assert.equal((await ack(f,{token:elle},1)).handled_cursor,2);
 assert.equal((await ack(f,{token:elle},2)).handled_cursor,2);
 assert.equal((await data(await f.request(ROOM+'/inbox',{token:em}))).handled_cursor,0);
 const transcript=await data(await f.request(ROOM+'/transcript',{cookie}));assert.equal(transcript.messages.length,2);assert.equal(transcript.room.agent_turns,2);
 // Acknowledgment remains available while writes are paused.
 await data(await f.request('/api/room',{method:'POST',cookie,body:{paused:true}}));
 await ack(f,{token:elle},2);await f.restart();
 const afterRestart=await data(await f.request(ROOM+'/inbox',{token:elle}));assert.equal(afterRestart.handled_cursor,2);assert.equal(afterRestart.messages.length,2,'Unspecified after retains existing read behavior.');
 assert.equal((await data(await f.request(ROOM+'/inbox?after=2',{token:elle}))).messages.length,0);
});

test('ack actions require authentication, existing sequences, integers and authenticated authorship',async t=> {
 const f=fixture(t),{elle,em}=await f.setup();await send(f,{token:em});
 assert.equal((await f.request(ROOM+'/messages',{method:'POST',body:{type:'ack',through_seq:1}})).status,401);
 for(const through_seq of [-1,1.1,'1',2,null,Number.MAX_SAFE_INTEGER+1])assert.equal((await f.request(ROOM+'/messages',{method:'POST',token:elle,body:{type:'ack',through_seq}})).status,400,String(through_seq));
 for(const extra of [{participant:'em'},{sender:'em'},{client_message_id:'unused'}])assert.equal((await f.request(ROOM+'/messages',{method:'POST',token:elle,body:{type:'ack',through_seq:1,...extra}})).status,400);
 assert.equal((await ack(f,{token:elle},0)).handled_cursor,0);
 assert.equal((await data(await f.request(ROOM+'/inbox',{token:elle}))).handled_cursor,0);
});

test('MCP lists and executes durable acknowledgment without exposing another participant cursor',async t=> {
 const f=fixture(t),{elle,em}=await f.setup();await send(f,{token:em});
 const list=await data(await f.request('/mcp',{method:'POST',token:elle,body:{jsonrpc:'2.0',id:1,method:'tools/list'}}));
 const tool=list.result.tools.find(tool=>tool.name==='relay_acknowledge');assert.ok(tool);assert.equal(tool.annotations.idempotentHint,true);
 assert.equal((await mcp(f,elle,'relay_acknowledge',{through_seq:1})).handled_cursor,1);
 assert.equal((await mcp(f,elle,'relay_read_inbox',{})).handled_cursor,1);
 assert.equal((await data(await f.request(ROOM+'/transcript',{token:em}))).handled_cursor,0);
});

test('cached MCP send tools acknowledge durably without chat events, turns or new notifications',async t=> {
 const deliveries=[],f=fixture(t,async item=>{deliveries.push(item);throw new Error('Temporary provider failure');}),{cookie,elle,em}=await f.setup();
 await send(f,{token:em});await send(f,{token:em});await f.app.flushDoorbells();
 await data(await f.request('/api/room',{method:'POST',cookie,body:{paused:true}}));
 const input={content:'',client_message_id:'elle-ack:2'};
 assert.deepEqual(await mcp(f,elle,'relay_send_message',input),{acknowledged:true,handled_cursor:2});
 assert.deepEqual(await mcp(f,elle,'relay_send_message',input),{acknowledged:true,handled_cursor:2});
 assert.equal((await mcp(f,elle,'relay_send_message',{content:'',client_message_id:'elle-ack:1',recipient:'all',images:[]})).handled_cursor,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,2);
 assert.equal(f.db.prepare('SELECT agent_turns FROM room').get().agent_turns,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM doorbell_outbox WHERE status='skipped'").get().n,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM doorbell_outbox').get().n,2);
 const attempts=deliveries.length;await f.restart();await f.app.flushDoorbells();assert.equal(deliveries.length,attempts);
 assert.equal((await mcp(f,elle,'relay_read_inbox',{})).handled_cursor,2);
 assert.equal((await data(await f.request(ROOM+'/transcript',{token:em}))).handled_cursor,0);
 const rotated=(await data(await f.request('/api/keys',{method:'POST',cookie,body:{participant:'elle'}}))).token;
 assert.equal((await mcp(f,rotated,'relay_read_inbox',{})).handled_cursor,2);
});

test('legacy MCP acknowledgment rejects ambiguous, malformed or spoofed empty sends',async t=> {
 const f=fixture(t),{elle,em}=await f.setup();await send(f,{token:em});
 const valid={content:'',client_message_id:'elle-ack:1'},invalid=[
  ...['','-1','01','+1','1.0','1e0','9007199254740992','2'].map(seq=>({...valid,client_message_id:'elle-ack:'+seq})),
  ...[{sender:'em'},{participant:'em'},{through_seq:1},{type:'ack'},{recipient:'em'},{recipient:'human'},{recipient:'elle'},{recipient:null},{images:null},{images:[{base64:'invalid',mime_type:'image/png'}]},{reply_to:1},{reply_to:null}].map(extra=>({...valid,...extra})),
  {client_message_id:'elle-ack:1'},{...valid,content:' '}
 ];
 for(const input of invalid) {
  const rpc=await data(await f.request('/mcp',{method:'POST',token:elle,body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'relay_send_message',arguments:input}}}));
  assert.equal(rpc.result.isError,true,JSON.stringify(input));
 }
 assert.equal((await mcp(f,elle,'relay_read_inbox',{})).handled_cursor,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
 assert.equal((await f.request(ROOM+'/messages',{method:'POST',token:elle,body:valid})).status,400,'Compatibility is limited to the cached MCP send tool.');
 assert.equal((await f.request('/mcp',{method:'POST',token:em,body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'relay_send_message',arguments:valid}}})).status,403);
 assert.equal((await mcp(f,elle,'relay_send_message',{content:'',client_message_id:'elle-ack:0'})).handled_cursor,0);
});

test('valid text, image and quote sends with an acknowledgment prefix remain ordinary messages',async t=> {
 const f=fixture(t),{elle,em}=await f.setup();await send(f,{token:em});
 const text=await mcp(f,elle,'relay_send_message',{content:'A normal message',client_message_id:'elle-ack:1'});
 assert.equal(text.message.content,'A normal message');assert.equal(text.acknowledged,undefined);
 const image=await mcp(f,elle,'relay_send_message',{content:'',client_message_id:'elle-ack:2',images:[{mime_type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJv0AAAAASUVORK5CYII='}]});
 assert.equal(image.message.images.length,1);assert.equal(image.acknowledged,undefined);
 const quote=await mcp(f,elle,'relay_send_message',{content:'A quoted reply',client_message_id:'elle-ack:3',reply_to:1});
 assert.equal(quote.message.reply_to,1);assert.equal(quote.acknowledged,undefined);
 assert.equal((await mcp(f,elle,'relay_read_inbox',{})).handled_cursor,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,4);
 assert.equal(f.db.prepare('SELECT agent_turns FROM room').get().agent_turns,4);
});

test('doorbell sends only safe metadata once for new human/Em messages addressed to Elle or all',async t=> {
 const deliveries=[],f=fixture(t,async item=>deliveries.push(item)),{cookie,elle,em}=await f.setup();
 await send(f,{token:em},'Never leak this content','elle','em-message');
 await send(f,{cookie},'Nor this content','all');
 await send(f,{token:em},'Only the owner','human');
 await send(f,{token:em},'Self-addressed','em');
 await send(f,{token:elle},'Elle must not notify herself','all');
 await data(await f.request(ROOM+'/messages',{method:'POST',token:em,body:{type:'reaction',message_seq:1,emoji:'😈',client_message_id:'em-react'}}),201);
 await ack(f,{token:em},6);
 await f.app.flushDoorbells();
 assert.deepEqual(deliveries,[{seq:1,origin:ORIGIN,sender:'em',recipient:'elle'},{seq:2,origin:ORIGIN,sender:'human',recipient:'all'}]);
 const retry=await data(await f.request(ROOM+'/messages',{method:'POST',token:em,body:{content:'Never leak this content',recipient:'elle',client_message_id:'em-message'}}));assert.equal(retry.deduplicated,true);
 await f.app.flushDoorbells();assert.equal(deliveries.length,2);
 const status=await data(await f.request('/api/room',{cookie}));assert.equal(status.doorbell.sent,2);assert.equal(status.doorbell.pending,0);
 assert.equal((await data(await f.request('/api/room',{token:em}))).doorbell,undefined,'Doorbell operations are owner metadata.');
});

test('a missing delivery function produces no outbox and paused rooms produce no doorbell',async t=> {
 const f=fixture(t),{cookie,em}=await f.setup();await send(f,{token:em});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM doorbell_outbox').get().n,0);
 const notifications=[];await f.restart(async item=>notifications.push(item));
 await data(await f.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:true}}));
 await data(await f.request('/api/room',{method:'POST',cookie,body:{paused:true}}));
 await send(f,{cookie},'Human message while paused');await f.app.flushDoorbells();assert.equal(notifications.length,0);
 await data(await f.request('/api/room',{method:'POST',cookie,body:{paused:false}}));
 await send(f,{token:em},'New active message');await f.app.flushDoorbells();assert.equal(notifications.length,1);
});

test('email transport is disabled by default and only an owner can activate a configured transport',async t=> {
 const notifications=[],f=fixture(t),{cookie,em}=await f.setup();
 assert.equal((await f.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:true}})).status,409);
 await f.restart(async item=>notifications.push(item));
 const before=await data(await f.request('/api/room',{cookie}));assert.equal(before.doorbell.configured,true);assert.equal(before.doorbell.enabled,false);assert.equal(before.room.doorbell_enabled,false);
 await send(f,{token:em},'No email before opt-in');await f.app.flushDoorbells();assert.equal(notifications.length,0);
 assert.equal((await f.request('/api/room',{method:'POST',token:em,body:{doorbell_enabled:true}})).status,403);
 assert.equal((await f.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:'yes'}})).status,400);
 await data(await f.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:true}}));await f.restart();
 assert.equal((await data(await f.request('/api/room',{cookie}))).doorbell.enabled,true);
 await send(f,{token:em},'Email after opt-in');await f.app.flushDoorbells();assert.equal(notifications.length,1);
 await data(await f.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:false}}));await send(f,{token:em},'No email after opt-out');await f.app.flushDoorbells();assert.equal(notifications.length,1);
});

test('a hung provider is bounded and leaves a retryable outbox without delaying message confirmation',async t=> {
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(t,()=>new Promise(()=>{})),{em}=await f.setup();
 const confirmation=await send(f,{token:em});assert.equal(confirmation.message.seq,1);
 const flush=f.app.flushDoorbells();t.mock.timers.tick(10000);await flush;
 const row=f.db.prepare('SELECT * FROM doorbell_outbox').get();assert.equal(row.status,'pending');assert.equal(row.last_error,'delivery_timeout');assert.equal(row.attempts,1);
 t.mock.timers.reset();
});

test('delivery failure retains the message and durable outbox; retries preserve sequence identity after restart',async t=> {
 const first=[],f=fixture(t,async item=>{first.push(item);throw new Error('provider key and private details must not be saved');}),{cookie,em}=await f.setup();
 await send(f,{token:em});await f.app.flushDoorbells();
 const row=f.db.prepare('SELECT * FROM doorbell_outbox').get();assert.equal(row.status,'pending');assert.equal(row.attempts,1);assert.equal(row.last_error,'delivery_failed');assert.ok(row.next_attempt_at>Date.now());
 const transcript=await data(await f.request(ROOM+'/transcript',{cookie}));assert.equal(transcript.messages.length,1);
 await f.app.flushDoorbells();assert.equal(first.length,1,'Backoff prevents request-driven spam.');
 const second=[];await f.restart(async item=>second.push(item));
 f.db.prepare('UPDATE doorbell_outbox SET next_attempt_at=0').run();await f.app.flushDoorbells();
 assert.deepEqual(second,first);assert.equal(f.db.prepare('SELECT attempts FROM doorbell_outbox').get().attempts,2);
 await f.restart();await f.app.flushDoorbells();assert.equal(second.length,1,'Successful deliveries are never resent on restart.');
});

test('pending retries obey owner pause and opt-out until both permit delivery',async t=> {
 const f=fixture(t,async()=>{throw new Error('Temporary provider failure');}),{cookie,em}=await f.setup();
 await send(f,{token:em});await f.app.flushDoorbells();
 await data(await f.request('/api/room',{method:'POST',cookie,body:{paused:true}}));
 const deliveries=[];await f.restart(async item=>deliveries.push(item));f.db.prepare('UPDATE doorbell_outbox SET next_attempt_at=0').run();
 await f.app.flushDoorbells();assert.equal(deliveries.length,0);
 await data(await f.request('/api/room',{method:'POST',cookie,body:{paused:false,doorbell_enabled:false}}));await f.app.flushDoorbells();assert.equal(deliveries.length,0);
 await data(await f.request('/api/room',{method:'POST',cookie,body:{doorbell_enabled:true}}));await f.app.flushDoorbells();assert.equal(deliveries.length,1);
});

test('concurrent request retries and flush calls share a durable delivery claim',async t=> {
 const deliveries=[];let release;
 const barrier=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,async item=>{deliveries.push(item);await barrier;}),{em}=await f.setup();
 const payload={content:'One notification',recipient:'elle',client_message_id:'same-post'};
 const responses=await Promise.all(Array.from({length:10},()=>f.request(ROOM+'/messages',{method:'POST',token:em,body:payload})));
 assert.equal(responses.filter(response=>response.status===201).length,1);
 const pending=Array.from({length:5},()=>f.app.flushDoorbells());
 const peerDb=new DatabaseSync(f.path);t.after(()=>peerDb.close());
 const peer=createApp({db:peerDb,origin:ORIGIN,ownerCode:OWNER,doorbell:async item=>deliveries.push(item)});
 await peer.flushDoorbells();assert.equal(deliveries.length,1);release();await Promise.all(pending);
 await f.app.flushDoorbells();assert.equal(deliveries.length,1);assert.equal(f.db.prepare('SELECT attempts FROM doorbell_outbox').get().attempts,1);
});

test('acknowledged pending notifications are skipped, while Em acknowledgment leaves Elle queue intact',async t=> {
 const f=fixture(t,async()=>{throw new Error('Temporary provider failure');}),{elle,em}=await f.setup();
 await send(f,{token:em});await f.app.flushDoorbells();await ack(f,{token:em},1);assert.equal(f.db.prepare('SELECT status FROM doorbell_outbox').get().status,'pending');
 await ack(f,{token:elle},1);assert.equal(f.db.prepare('SELECT status FROM doorbell_outbox').get().status,'skipped');
 const notifications=[];await f.restart(async item=>notifications.push(item));await f.app.flushDoorbells();assert.equal(notifications.length,0);
});

test('expired uncertain delivery leases retry, and provider can deduplicate by unchanged origin and seq',async t=> {
 const delivered=new Set(),attempts=[],f=fixture(t,async item=>{const id=item.origin+':'+item.seq;attempts.push(id);delivered.add(id);}),{em}=await f.setup();
 await send(f,{token:em});await f.app.flushDoorbells();
 // Simulate process death after provider success but before SQLite success acknowledgment.
 f.db.prepare("UPDATE doorbell_outbox SET status='sending',lease_until=0,sent_at=NULL").run();await f.restart();await f.app.flushDoorbells();
 assert.equal(attempts.length,2);assert.equal(delivered.size,1);assert.equal(attempts[0],attempts[1]);
});
