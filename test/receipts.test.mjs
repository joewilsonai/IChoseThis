import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../src/app.mjs';

const ORIGIN = 'http://localhost:3000';
const OWNER_CODE = 'test-owner-code-with-at-least-32-characters';
const ROOM = '/api/rooms/elle-em';
const ROOT = resolve(import.meta.dirname, '..');

function fixture(t) {
 const dir = mkdtempSync(join(tmpdir(), 'receipts-test-'));
 const path = join(dir, 'relay.sqlite');
 let db = new DatabaseSync(path);
 const config = { origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>', css: '', js: '', cli: '', integration: '' };
 let app = createApp({ ...config, db });
 t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
 return {
  async request(pathname, options = {}) {
   const { method = 'GET', body, token, cookie } = options;
   const headers = new Headers();
   if (token) headers.set('Authorization', `Bearer ${token}`);
   if (cookie) headers.set('Cookie', cookie);
   let requestBody;
   if (body !== undefined) { headers.set('Content-Type', 'application/json'); requestBody = JSON.stringify(body); }
   return app.fetch(new Request(`${ORIGIN}${pathname}`, { method, headers, body: requestBody }));
  },
  restart() { db.close(); db = new DatabaseSync(path); app = createApp({ ...config, db }); },
  sql(query, ...args) { return db.prepare(query).run(...args); },
 };
}

async function json(response, expectedStatus = 200) {
 const body = await response.text();
 assert.equal(response.status, expectedStatus, `${response.status}: ${body}`);
 return JSON.parse(body);
}

async function login(f) {
 const response = await f.request('/api/login', { method: 'POST', body: { access_code: OWNER_CODE } });
 assert.equal(response.status, 200);
 return response.headers.get('set-cookie').split(';')[0];
}

async function key(f, cookie, participant) {
 return (await json(await f.request('/api/keys', { method: 'POST', cookie, body: { participant } }))).token;
}

const post = (f, auth, content, recipient = 'all') =>
 f.request(`${ROOM}/messages`, { method: 'POST', ...auth, body: { content, recipient, client_message_id: randomUUID() } });

const mcp = (f, token, method, params = {}, id = 1) => f.request('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id, method, params } });

test('reading a page is seeing it: every seat that fetched a message is listed under it, never its sender', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const luna = await key(f, cookie, 'luna');
 const first = await json(await post(f, { cookie }, 'For everyone'), 201);
 const second = await json(await post(f, { token: em }, 'From Em'), 201);
 assert.deepEqual(first.message.seen_by, [], 'nobody has read it yet');
 await json(await f.request(`${ROOM}/inbox?after=0`, { token: luna }));
 const owner = await json(await f.request(`${ROOM}/transcript?after=0`, { cookie }));
 const bySeq = Object.fromEntries(owner.messages.map(m => [m.seq, m.seen_by]));
 assert.deepEqual(bySeq[first.message.seq], ['luna']);
 assert.deepEqual(bySeq[second.message.seq], ['luna']);
 const emView = await json(await f.request(`${ROOM}/transcript?after=0`, { token: em }));
 const emBySeq = Object.fromEntries(emView.messages.map(m => [m.seq, m.seen_by]));
 assert.deepEqual(emBySeq[first.message.seq], ['luna'], 'the owner wrote it, so the owner is not listed as a reader of it');
 assert.deepEqual(emBySeq[second.message.seq], ['human', 'luna'], 'the owner read it on the page above; Em wrote it and is not listed');
});

test('seeing is per message: a seat that fetched only what was addressed to it has not seen the rest', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const toElle = await json(await post(f, { cookie }, 'Elle only', 'elle'), 201);
 const toAll = await json(await post(f, { cookie }, 'Everyone'), 201);
 await json(await f.request(`${ROOM}/inbox?after=0`, { token: em }));          // Em's inbox holds only the second
 const owner = await json(await f.request(`${ROOM}/transcript?after=0`, { cookie }));
 const bySeq = Object.fromEntries(owner.messages.map(m => [m.seq, m.seen_by]));
 assert.deepEqual(bySeq[toElle.message.seq], [], 'Em never fetched it');
 assert.deepEqual(bySeq[toAll.message.seq], ['em']);
});

test('receipts for the recent stretch come back with every page, so a page already on screen learns who has seen it since', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 await json(await post(f, { cookie }, 'one'), 201);
 await json(await post(f, { cookie }, 'two'), 201);
 const before = await json(await f.request(`${ROOM}/transcript?after=0`, { cookie }));
 assert.deepEqual(before.receipts, {}, 'the owner wrote both; reading your own words is not a receipt');
 await json(await f.request(`${ROOM}/inbox?after=0&limit=1`, { token: em }));
 const after = await json(await f.request(`${ROOM}/transcript?after=2`, { cookie }));
 assert.deepEqual(after.messages, []);
 assert.deepEqual(after.receipts, { 1: ['em'] }, 'an empty page still carries the recent receipts');
});

test('a smaller later page unsees nothing, an empty page marks nothing, and a seat never sees its own words', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 for (const content of ['a', 'b']) await json(await post(f, { cookie }, content), 201);
 await json(await post(f, { token: em }, 'c'), 201);
 await json(await f.request(`${ROOM}/transcript?after=0`, { token: em }));
 await json(await f.request(`${ROOM}/transcript?after=0&limit=1`, { token: em }));
 await json(await f.request(`${ROOM}/transcript?after=3`, { token: em }));
 const view = await json(await f.request(`${ROOM}/transcript?after=0`, { cookie }));
 assert.deepEqual(view.receipts, { 1: ['em'], 2: ['em'], 3: ['human'] });
});

test('receipts survive a restart and reach Elle through her MCP tools', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const elle = await key(f, cookie, 'elle');
 const em = await key(f, cookie, 'em');
 const posted = await json(await post(f, { cookie }, 'Elle, did you see this?', 'elle'), 201);
 await json(await f.request(`${ROOM}/transcript?after=0`, { token: em }));   // a message to Elle is not in Em's inbox, but the room is open to her
 f.restart();
 const read = await json(await mcp(f, elle, 'tools/call', { name: 'relay_read_inbox', arguments: { after: 0, limit: 20 } }, 2));
 const data = JSON.parse(read.result.content.find(c => c.type === 'text').text);
 assert.deepEqual(data.messages[0].seen_by, ['em']);
 assert.deepEqual(data.receipts[String(posted.message.seq)], ['elle', 'em']);
 const owner = await json(await f.request(`${ROOM}/transcript?after=0`, { cookie }));
 assert.deepEqual(owner.messages[0].seen_by, ['elle', 'em'], 'Elle read it through MCP');
});

test('a late read of an old message still reaches a page that is only polling for new ones', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 for (let index = 0; index < 85; index++) await json(await post(f, { cookie }, `message ${index + 1}`), 201);
 let cursor = 0;
 for (let pages = 0; pages < 3; pages++) cursor = (await json(await f.request(`${ROOM}/transcript?after=${cursor}&limit=50`, { cookie }))).next_cursor;
 assert.equal(cursor, 85);
 await json(await f.request(`${ROOM}/transcript?after=0&limit=1`, { token: em }));       // Em reads message 1, long after the fact
 const poll = await json(await f.request(`${ROOM}/transcript?after=85`, { cookie }));
 assert.deepEqual(poll.messages, []);
 assert.deepEqual(poll.receipts['1'], ['em'], 'a receipt written just now comes back even for an old message');
});

test('reading a reaction is reading the message it points at, and the reaction carries that message’s receipts', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const luna = await key(f, cookie, 'luna');
 const toElle = await json(await post(f, { cookie }, 'Elle, a question', 'elle'), 201);
 await json(await f.request(`${ROOM}/transcript?after=0`, { token: luna }));            // Luna has seen it
 const reacted = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body: { type: 'reaction', message_seq: toElle.message.seq, emoji: '🔥', client_message_id: randomUUID() } }), 201);
 assert.deepEqual(reacted.message.target_message.seen_by, ['luna'], 'the reaction response shows who has seen its target');
 const emInbox = await json(await f.request(`${ROOM}/inbox?after=0`, { token: em }));    // Em's inbox holds only her own reaction's echo? no: reactions by Em are excluded; so nothing
 assert.deepEqual(emInbox.messages, []);
 const lunaInbox = await json(await f.request(`${ROOM}/inbox?after=1`, { token: luna })); // Luna's inbox holds the reaction event with the target's full text
 assert.equal(lunaInbox.messages[0].type, 'reaction');
 const elle = await key(f, cookie, 'elle');
 await json(await f.request(`${ROOM}/inbox?after=1`, { token: elle }));                  // Elle reads only the reaction, and with it the message
 const owner = await json(await f.request(`${ROOM}/transcript?after=0`, { cookie }));
 assert.deepEqual(owner.messages[0].seen_by, ['elle', 'luna'], 'Elle saw the message through the reaction; Em reacted without ever reading it');
});

test('an old message with an old receipt and a fresh one reports both readers, on a poll and on a reaction', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const luna = await key(f, cookie, 'luna');
 for (let index = 0; index < 85; index++) await json(await post(f, { cookie }, `message ${index + 1}`), 201);
 await json(await f.request(`${ROOM}/transcript?after=0&limit=1`, { token: em }));
 f.sql("UPDATE seen SET created_at='2026-01-01T00:00:00.000Z' WHERE seq=1 AND participant='em'");   // Em read it an age ago
 await json(await f.request(`${ROOM}/transcript?after=0&limit=1`, { token: luna }));              // Luna reads it now
 const poll = await json(await f.request(`${ROOM}/transcript?after=85`, { cookie }));
 assert.deepEqual(poll.receipts['1'], ['em', 'luna'], 'a message that qualifies brings every reader it has');
 const reacted = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body: { type: 'reaction', message_seq: 1, emoji: '🔥', client_message_id: randomUUID() } }), 201);
 assert.deepEqual(reacted.message.target_message.seen_by, ['luna'], 'Em is the viewer; Luna has seen it');
 const owner = await json(await f.request(`${ROOM}/transcript?after=85`, { cookie }));
 assert.deepEqual(owner.receipts['1'], ['em', 'luna']);
});

test('the page shows who has seen each message', () => {
 const js = readFileSync(resolve(ROOT, 'src/ui.js'), 'utf8');
 const css = readFileSync(resolve(ROOT, 'src/ui.css'), 'utf8');
 assert.match(js, /result\.receipts/);
 assert.match(js, /message-seen/);
 assert.match(css, /\.message-seen\{/);
});
