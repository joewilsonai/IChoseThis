import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
const hash = value => createHash('sha256').update(value).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The room exactly as it shipped on 2026-10-08 (commit f3bb696), before Luna had a
// seat: the messages table names the three original participants in CHECK
// constraints, and the old application then widened it with ALTER TABLE.
const THREE_SEAT_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE room (
 id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
 turn_limit INTEGER NOT NULL DEFAULT 20, agent_turns INTEGER NOT NULL DEFAULT 0
);
INSERT INTO room(id) VALUES ('elle-em');
CREATE TABLE messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES room(id),
 sender TEXT NOT NULL CHECK(sender IN ('human','elle','em')),
 recipient TEXT NOT NULL CHECK(recipient IN ('human','elle','em','all')),
 content TEXT NOT NULL, client_message_id TEXT NOT NULL,
 reply_to INTEGER REFERENCES messages(seq), created_at TEXT NOT NULL,
 UNIQUE(room,sender,client_message_id)
);
CREATE INDEX idx_messages_room_seq ON messages(room,seq);
CREATE TABLE credentials (
 hash TEXT PRIMARY KEY, participant TEXT NOT NULL,
 kind TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE participants (
 id TEXT PRIMARY KEY, last_seen TEXT
);
INSERT INTO participants(id) VALUES ('human'),('elle'),('em');
CREATE TABLE images (
 id TEXT PRIMARY KEY, message_seq INTEGER NOT NULL REFERENCES messages(seq),
 ordinal INTEGER NOT NULL, mime_type TEXT NOT NULL, filename TEXT NOT NULL,
 size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(message_seq,ordinal)
);
CREATE TABLE reactions (
 message_seq INTEGER NOT NULL REFERENCES messages(seq), participant TEXT NOT NULL,
 emoji TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(message_seq,participant,emoji)
);
CREATE TABLE handled_cursors (
 room TEXT NOT NULL REFERENCES room(id), participant TEXT NOT NULL,
 through_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 PRIMARY KEY(room,participant)
);
CREATE TABLE doorbell_outbox (
 seq INTEGER PRIMARY KEY REFERENCES messages(seq), status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, sent_at TEXT, last_error TEXT
);
ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'message';
ALTER TABLE messages ADD COLUMN reaction_target INTEGER REFERENCES messages(seq);
ALTER TABLE messages ADD COLUMN reaction_emoji TEXT;
ALTER TABLE messages ADD COLUMN reaction_active INTEGER;
ALTER TABLE messages ADD COLUMN payload_hash TEXT;
ALTER TABLE room ADD COLUMN doorbell_enabled INTEGER NOT NULL DEFAULT 0;
`;

const OLD_EM_KEY = 'em-key-issued-before-luna-joined-0123456789';

// A room with history: three messages with a gap in the sequence, one quote reply, one
// picture, one reaction, Em's handled cursor, a pending doorbell, and Em's old key.
function seedThreeSeatRoom(db) {
 db.exec(THREE_SEAT_SCHEMA);
 const now = '2026-10-08T20:00:00.000Z';
 const insert = db.prepare('INSERT INTO messages(seq,room,sender,recipient,content,client_message_id,reply_to,created_at,type) VALUES (?,?,?,?,?,?,?,?,?)');
 insert.run(1, 'elle-em', 'human', 'all', 'Welcome to the room', 'h-1', null, now, 'message');
 insert.run(2, 'elle-em', 'em', 'human', 'Here is a picture', 'em-1', 1, now, 'message');
 insert.run(7, 'elle-em', 'elle', 'em', 'Replying after a gap', 'elle-1', null, now, 'message');
 // A message that was once the newest and was removed by hand: the AUTOINCREMENT
 // counter stays at 9, and a widened room must not hand 8 or 9 out again.
 insert.run(9, 'elle-em', 'elle', 'em', 'Deleted by hand', 'elle-2', null, now, 'message');
 db.exec('DELETE FROM messages WHERE seq=9');
 db.prepare('INSERT INTO images(id,message_seq,ordinal,mime_type,filename,size,sha256,data,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('a'.repeat(32), 2, 0, 'image/png', 'dot.png', PNG.length, hash(PNG), PNG, now);
 db.prepare('INSERT INTO reactions(message_seq,participant,emoji,created_at,updated_at) VALUES (?,?,?,?,?)').run(1, 'em', '🔥', now, now);
 db.prepare('INSERT INTO handled_cursors(room,participant,through_seq,updated_at) VALUES (?,?,?,?)').run('elle-em', 'em', 2, now);
 db.prepare('INSERT INTO doorbell_outbox(seq) VALUES (?)').run(7);
 db.prepare('INSERT INTO credentials(hash,participant,kind,expires_at,created_at) VALUES (?,?,?,?,?)').run(hash(OLD_EM_KEY), 'em', 'api', Date.now() + 86400000, Date.now());
}

function fixture(t, { before } = {}) {
 const dir = mkdtempSync(join(tmpdir(), 'luna-seat-test-'));
 const path = join(dir, 'relay.sqlite');
 let db = new DatabaseSync(path);
 if (before) before(db);
 const config = { origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>', css: '', js: '', cli: '', integration: '' };
 let app = createApp({ ...config, db });
 t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
 return {
  async request(pathname, options = {}) {
   const { method = 'GET', body, token, cookie, headers = {} } = options;
   const requestHeaders = new Headers(headers);
   if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
   if (cookie) requestHeaders.set('Cookie', cookie);
   let requestBody;
   if (body !== undefined) { requestHeaders.set('Content-Type', 'application/json'); requestBody = JSON.stringify(body); }
   return app.fetch(new Request(`${ORIGIN}${pathname}`, { method, headers: requestHeaders, body: requestBody }));
  },
  restart() { db.close(); db = new DatabaseSync(path); app = createApp({ ...config, db }); },
  sql(query) { return db.prepare(query).all().map(row => ({ ...row })); }
 };
}

async function json(response, expectedStatus = 200) {
 const body = await response.text();
 assert.equal(response.status, expectedStatus, `${response.status}: ${body}`);
 return JSON.parse(body);
}

async function login(f) {
 const response = await f.request('/api/login', { method: 'POST', body: { access_code: OWNER_CODE } });
 assert.equal(response.status, 200, await response.clone().text());
 return response.headers.get('set-cookie').split(';')[0];
}

async function key(f, cookie, participant) {
 const data = await json(await f.request('/api/keys', { method: 'POST', cookie, body: { participant } }));
 assert.equal(data.participant, participant);
 assert.ok(data.token.length >= 24);
 return data.token;
}

const post = (f, auth, content, recipient = 'all', extras = {}) =>
 f.request(`${ROOM}/messages`, { method: 'POST', ...auth, body: { content, recipient, client_message_id: randomUUID(), ...extras } });

const mcp = (f, token, method, params = {}, id = 1) => f.request('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id, method, params } });
const toolData = result => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(item => item.type === 'text').text); };

test('a fresh room seats Luna beside Elle and Em', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const room = await json(await f.request('/api/room', { cookie }));
 assert.deepEqual(room.participants.map(p => p.id), ['elle', 'em', 'human', 'luna']);
});

test('the owner can create a Luna key, and it posts only as Luna with no owner powers', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const luna = await key(f, cookie, 'luna');
 const posted = await json(await post(f, { token: luna }, 'Luna is here'), 201);
 assert.equal(posted.message.sender, 'luna');
 assert.equal((await post(f, { token: luna }, 'Spoofed', 'all', { sender: 'elle' })).status, 400);
 assert.equal((await f.request('/api/room', { method: 'POST', token: luna, body: { paused: true } })).status, 403);
 assert.equal((await f.request('/api/keys', { method: 'POST', token: luna, body: { participant: 'em' } })).status, 403);
 assert.equal((await f.request('/api/keys', { method: 'POST', cookie, body: { participant: 'human' } })).status, 400);
});

test('creating a new Luna key revokes the old one and leaves Em and Elle untouched', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const oldLuna = await key(f, cookie, 'luna');
 const em = await key(f, cookie, 'em');
 const newLuna = await key(f, cookie, 'luna');
 assert.equal((await f.request(`${ROOM}/inbox`, { token: oldLuna })).status, 401);
 await json(await f.request(`${ROOM}/inbox`, { token: newLuna }));
 await json(await f.request(`${ROOM}/inbox`, { token: em }));
});

test('messages addressed to Luna reach her inbox and nobody else’s, and everyone sees them in the transcript', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const luna = await key(f, cookie, 'luna');
 const em = await key(f, cookie, 'em');
 const toLuna = await json(await post(f, { cookie }, 'For Luna', 'luna'), 201);
 const toEm = await json(await post(f, { cookie }, 'For Em', 'em'), 201);
 const toAll = await json(await post(f, { cookie }, 'For everyone', 'all'), 201);
 const fromLuna = await json(await post(f, { token: luna }, 'Luna speaking', 'all'), 201);
 const lunaInbox = await json(await f.request(`${ROOM}/inbox`, { token: luna }));
 assert.deepEqual(lunaInbox.messages.map(m => m.seq), [toLuna.message.seq, toAll.message.seq]);
 const emInbox = await json(await f.request(`${ROOM}/inbox`, { token: em }));
 assert.deepEqual(emInbox.messages.map(m => m.seq), [toEm.message.seq, toAll.message.seq, fromLuna.message.seq]);
 const transcript = await json(await f.request(`${ROOM}/transcript`, { token: em }));
 assert.equal(transcript.messages.length, 4);
 assert.equal(transcript.messages[0].recipient, 'luna');
});

test('Luna’s turns count against the shared agent turn limit and her acknowledgements keep their own cursor', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const luna = await key(f, cookie, 'luna');
 const em = await key(f, cookie, 'em');
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { turn_limit: 1 } }));
 const first = await json(await post(f, { token: luna }, 'One agent turn'), 201);
 assert.equal((await post(f, { token: em }, 'Second consecutive agent turn')).status, 429);
 const ack = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: luna, body: { type: 'ack', through_seq: first.message.seq } }));
 assert.equal(ack.handled_cursor, first.message.seq);
 const emInbox = await json(await f.request(`${ROOM}/inbox`, { token: em }));
 assert.equal(emInbox.handled_cursor, 0);
});

test('Elle’s MCP tools accept Luna as a recipient and advertise her in the schema', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const elle = await key(f, cookie, 'elle');
 const luna = await key(f, cookie, 'luna');
 const listed = await json(await mcp(f, elle, 'tools/list'));
 const send = listed.result.tools.find(tool => tool.name === 'relay_send_message');
 assert.deepEqual(send.inputSchema.properties.recipient.enum, ['em', 'luna', 'human', 'all']);
 const delivered = await json(await mcp(f, elle, 'tools/call', { name: 'relay_send_message', arguments: { content: 'Elle to Luna', recipient: 'luna', client_message_id: randomUUID() } }, 2));
 assert.equal(toolData(delivered.result).message.recipient, 'luna');
 const inbox = await json(await f.request(`${ROOM}/inbox`, { token: luna }));
 assert.equal(inbox.messages.at(-1).content, 'Elle to Luna');
});

test('a room built before Luna had a seat keeps every message, picture, reaction, cursor and key after she is added', async (t) => {
 const f = fixture(t, { before: seedThreeSeatRoom });
 const cookie = await login(f);
 const transcript = await json(await f.request(`${ROOM}/transcript`, { cookie }));
 assert.deepEqual(transcript.messages.map(m => [m.seq, m.sender, m.content]), [[1, 'human', 'Welcome to the room'], [2, 'em', 'Here is a picture'], [7, 'elle', 'Replying after a gap']]);
 assert.equal(transcript.messages[1].reply.seq, 1);
 assert.equal(transcript.messages[1].images[0].filename, 'dot.png');
 assert.deepEqual(transcript.messages[0].reactions.map(r => [r.participant, r.emoji]), [['em', '🔥']]);
 const emInbox = await json(await f.request(`${ROOM}/inbox`, { token: OLD_EM_KEY }));
 assert.equal(emInbox.handled_cursor, 2, 'Em’s handled cursor survives');
 assert.deepEqual(f.sql('SELECT seq,status FROM doorbell_outbox'), [{ seq: 7, status: 'pending' }]);
 const luna = await key(f, cookie, 'luna');
 const posted = await json(await post(f, { token: luna }, 'First words from the fourth seat', 'all'), 201);
 assert.equal(posted.message.seq, 10, 'new messages continue after the old counter, not after the surviving rows');
 await json(await post(f, { cookie }, 'A note for Luna', 'luna'), 201);
 assert.equal(f.sql('PRAGMA foreign_key_check').length, 0);
 f.restart();
 const again = await json(await f.request(`${ROOM}/transcript`, { token: OLD_EM_KEY }));
 assert.equal(again.messages.length, 5, 'the migration is idempotent across restarts');
 assert.deepEqual(f.sql("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_room_seq'"), [{ name: 'idx_messages_room_seq' }]);
});

test('the shipped page, script and CLI know Luna', () => {
 const html = readFileSync(resolve(ROOT, 'src/ui.html'), 'utf8');
 const js = readFileSync(resolve(ROOT, 'src/ui.js'), 'utf8');
 const css = readFileSync(resolve(ROOT, 'src/ui.css'), 'utf8');
 const cli = readFileSync(resolve(ROOT, 'relay.py'), 'utf8');
 assert.match(html, /<option value="luna">Luna<\/option>/);
 assert.match(html, /id="create-luna-key"/);
 assert.match(html, /id="luna-status"/);
 assert.match(js, /luna: "Luna"/);
 assert.match(css, /\.avatar-luna\{/);
 assert.match(css, /\.sender-luna \.message-name\{/);
 assert.match(cli, /choices=\("elle", "em", "luna", "all"\)/);
});
