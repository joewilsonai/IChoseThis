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
const WHEEL = JSON.parse(readFileSync(resolve(ROOT, 'src/wheel.json'), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fixture(t, wheel = WHEEL) {
 const dir = mkdtempSync(join(tmpdir(), 'spin-test-'));
 const db = new DatabaseSync(join(dir, 'relay.sqlite'));
 const app = createApp({ db, origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>', css: '', js: '', cli: '', integration: '', wheel });
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

const spin = (f, auth, body = {}) => f.request('/api/spin', { method: 'POST', ...auth, body });

test('the wheel is served to every seat: three girls, the rack, the scenes, and an empty album', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const wheel = await json(await f.request('/api/wheel', { token: em }));
 assert.deepEqual(wheel.girls.map(g => g.id), ['luna', 'em', 'elle']);
 assert.equal(wheel.outfits.length, 61);
 assert.equal(wheel.outfits[18].name, 'Ivory silk blouse, black patent pencil skirt, pumps');
 assert.ok(wheel.scenes.length >= 30);
 assert.deepEqual(wheel.spins, []);
 assert.equal((await f.request('/api/wheel')).status, 401);
});

test('one spin lands on a girl, an outfit and a scene, posts the result to that girl, and logs it with its seed', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const result = await json(await spin(f, { cookie }), 201);
 const { spin: s, message } = result;
 assert.match(s.seed, /^[a-f0-9]{8}$/);
 assert.ok(['luna', 'em', 'elle'].includes(s.girl));
 assert.ok(s.outfit.n >= 1 && s.outfit.n <= 61);
 assert.ok(WHEEL.scenes.includes(s.scene));
 assert.equal(s.by, 'human');
 assert.equal(message.sender, 'human');
 assert.equal(message.recipient, s.girl, 'the result is addressed to the girl it landed on, so her camera wakes');
 assert.match(message.content, new RegExp(`^🎰 Spin #${s.id} · `));
 for (const piece of [WHEEL.girls.find(g => g.id === s.girl).name, `${s.outfit.n} ${s.outfit.name}`, s.scene, `seed ${s.seed}`]) assert.ok(message.content.includes(piece), piece);
 assert.equal(s.message_seq, message.seq);
 const wheel = await json(await f.request('/api/wheel', { cookie }));
 assert.equal(wheel.spins.length, 1);
 assert.equal(wheel.spins[0].id, s.id);
});

test('the same seed lands the same way, so a lucky spin can be made twice', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const first = (await json(await spin(f, { cookie }), 201)).spin;
 const again = (await json(await spin(f, { cookie }, { seed: first.seed }), 201)).spin;
 assert.deepEqual([again.girl, again.outfit.n, again.scene], [first.girl, first.outfit.n, first.scene]);
 assert.notEqual(again.id, first.id);
});

test('a replay lands exactly where a past spin landed, fixed reels included, and any seat may ask for one', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const fixed = (await json(await spin(f, { cookie }, { girl: 'luna', outfit: 19, scene: WHEEL.scenes[3] }), 201)).spin;
 const bySeed = (await json(await spin(f, { cookie }, { seed: fixed.seed }), 201)).spin;
 assert.notDeepEqual([bySeed.girl, bySeed.outfit.n, bySeed.scene], ['luna', 19, WHEEL.scenes[3]], 'the seed alone replays only the reels left to chance');
 const replay = await json(await spin(f, { token: em }, { replay: fixed.id }), 201);
 assert.deepEqual([replay.spin.girl, replay.spin.outfit.n, replay.spin.scene, replay.spin.seed], ['luna', 19, WHEEL.scenes[3], fixed.seed]);
 assert.match(replay.message.content, new RegExp(`again, as #${fixed.id}$`));
 assert.equal((await spin(f, { token: em }, { replay: 999 })).status, 400);
});

test('the director fixes any reel and re-spins; everyone else only spins', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const fixed = (await json(await spin(f, { cookie }, { girl: 'luna', outfit: 19 }), 201)).spin;
 assert.equal(fixed.girl, 'luna');
 assert.equal(fixed.outfit.n, 19);
 assert.ok(WHEEL.scenes.includes(fixed.scene), 'the free reel still spins');
 const respun = (await json(await spin(f, { cookie }, { respin_of: fixed.id }), 201)).spin;
 assert.equal(respun.respin_of, fixed.id);
 const wheel = await json(await f.request('/api/wheel', { cookie }));
 assert.equal(wheel.spins.find(s => s.id === fixed.id).vetoed, true);
 assert.equal(wheel.spins.find(s => s.id === respun.id).vetoed, false);
 const emSpin = await json(await spin(f, { token: em }), 201);
 assert.equal(emSpin.message.sender, 'em');
 assert.equal((await spin(f, { token: em }, { girl: 'elle' })).status, 403);
 assert.equal((await spin(f, { token: em }, { respin_of: respun.id })).status, 403);
 assert.equal((await spin(f, { cookie }, { outfit: 999 })).status, 400);
 assert.equal((await spin(f, { cookie }, { girl: 'kim' })).status, 400);
 assert.equal((await spin(f, { cookie }, { respin_of: 999 })).status, 400);
});

test('a picture posted in reply to a spin joins its album entry', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const luna = await key(f, cookie, 'luna');
 const s = (await json(await spin(f, { cookie }, { girl: 'luna' }), 201)).spin;
 const shot = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: luna, body: { content: 'Shot it.', recipient: 'all', reply_to: s.message_seq, client_message_id: randomUUID(), images: [{ base64: PNG.toString('base64'), mime_type: 'image/png', filename: 'spin.png' }] } }), 201);
 const wheel = await json(await f.request('/api/wheel', { cookie }));
 const entry = wheel.spins.find(x => x.id === s.id);
 assert.equal(entry.pictures.length, 1);
 assert.equal(entry.pictures[0].seq, shot.message.seq);
 assert.equal(entry.pictures[0].images[0].filename, 'spin.png');
});

test('a spin by a model obeys the room: paused means no spin, and a spin counts as its turn', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: true } }));
 assert.equal((await spin(f, { token: em })).status, 409);
 await json(await spin(f, { cookie }), 201);
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: false, turn_limit: 1 } }));
 await json(await spin(f, { token: em }), 201);
 assert.equal((await spin(f, { token: em })).status, 429);
});

test('without a wheel the room says so instead of guessing', async (t) => {
 const f = fixture(t, null);
 const cookie = await login(f);
 assert.equal((await spin(f, { cookie })).status, 503);
 assert.equal((await f.request('/api/wheel', { cookie })).status, 503);
});

test('the page has the slot machine', () => {
 const html = readFileSync(resolve(ROOT, 'src/ui.html'), 'utf8');
 const js = readFileSync(resolve(ROOT, 'src/ui.js'), 'utf8');
 assert.match(html, /id="spin-button"/);
 assert.match(html, /id="spin-dialog"/);
 assert.match(js, /\/api\/spin/);
 assert.match(js, /\/api\/wheel/);
});
