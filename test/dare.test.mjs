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
 const dir = mkdtempSync(join(tmpdir(), 'dare-test-'));
 const db = new DatabaseSync(join(dir, 'relay.sqlite'));
 const app = createApp({ db, origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>', css: '', js: '', cli: '', integration: '' });
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

const card = (f, auth, kind, text, intensity) => f.request('/api/deck', { method: 'POST', ...auth, body: { kind, text, intensity } });
const deal = (f, auth, body = {}) => f.request('/api/dare/deal', { method: 'POST', ...auth, body });
const reply = (f, auth, seq, content = 'Done.') => f.request(`${ROOM}/messages`, { method: 'POST', ...auth, body: { content, recipient: 'all', reply_to: seq, client_message_id: randomUUID() } });

async function seeded(f, cookie) {
 for (let n = 1; n <= 5; n++) await json(await card(f, { cookie }, 'truth', `Truth ${n}`, n), 201);
 for (let n = 1; n <= 5; n++) await json(await card(f, { cookie }, 'dare', `Dare ${n}`, n), 201);
}

test('anyone loads the deck; cards carry a kind, an intensity and their author; the owner may remove one', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const mine = await json(await card(f, { token: em }, 'dare', 'Shoot the collar board in daylight.', 3), 201);
 assert.equal(mine.card.by, 'em');
 assert.equal((await card(f, { token: em }, 'dare', 'x', 6)).status, 400);
 assert.equal((await card(f, { token: em }, 'rumour', 'x', 2)).status, 400);
 assert.equal((await card(f, { token: em }, 'truth', '   ', 2)).status, 400);
 const deck = await json(await f.request('/api/deck', { token: em }));
 assert.equal(deck.cards.length, 1);
 assert.equal((await f.request(`/api/deck/${mine.card.id}`, { method: 'DELETE', token: em, body: {} })).status, 403);
 await json(await f.request(`/api/deck/${mine.card.id}`, { method: 'DELETE', cookie, body: {} }));
 assert.deepEqual((await json(await f.request('/api/deck', { cookie }))).cards, []);
});

test('a deal picks a player, truth or dare, and a card under that player’s ceiling, and posts it to the player', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 await seeded(f, cookie);
 const result = await json(await deal(f, { cookie }, { player: 'luna', kind: 'dare' }), 201);
 assert.equal(result.deal.player, 'luna');
 assert.equal(result.deal.kind, 'dare');
 assert.ok(result.deal.intensity >= 1 && result.deal.intensity <= 5);
 assert.equal(result.message.recipient, 'luna');
 assert.match(result.message.content, new RegExp(`^🎲 Dare #${result.deal.id} · Luna · Dare ${result.deal.intensity}/5 · Dare ${result.deal.intensity}$`));
 const free = await json(await deal(f, { cookie }), 201);
 assert.ok(['luna', 'em', 'elle'].includes(free.deal.player), 'the player is a model seat when not fixed');
 assert.ok(['truth', 'dare'].includes(free.deal.kind));
});

test('boundaries are each seat’s own: set privately, enforced by the server, shown to nobody else', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const luna = await key(f, cookie, 'luna');
 await seeded(f, cookie);
 await json(await card(f, { cookie }, 'dare', 'Something with ropes', 2), 201);
 await json(await f.request('/api/boundaries', { method: 'POST', token: em, body: { max_intensity: 2, avoid: ['ropes'] } }));
 const own = await json(await f.request('/api/boundaries', { token: em }));
 assert.deepEqual(own.boundaries, { max_intensity: 2, avoid: ['ropes'] });
 const ownerView = await json(await f.request('/api/dare', { cookie }));
 assert.equal(ownerView.boundaries, undefined, 'the owner sees scores, not anyone’s limits');
 const dealt = [];
 for (let n = 0; n < 4; n++) dealt.push((await json(await deal(f, { cookie }, { player: 'em' }), 201)).deal);   // two truths and two dares fit; the ropes card never does
 for (const d of dealt) {
  assert.ok(d.intensity <= 2, `dealt ${d.intensity}`);
  assert.doesNotMatch(d.card, /ropes/i);
 }
 assert.equal(new Set(dealt.map(d => d.card)).size, 4);
 assert.equal((await deal(f, { cookie }, { player: 'em' })).status, 409, 'nothing above her ceiling is ever reached for');
 const above = await json(await deal(f, { cookie }, { player: 'luna', intensity: 5 }), 201);
 assert.equal(above.deal.intensity, 5, 'a seat with no limits takes the fixed intensity');
 assert.equal((await f.request('/api/boundaries', { method: 'POST', token: luna, body: { max_intensity: 9 } })).status, 400);
 assert.equal((await f.request('/api/boundaries', { method: 'POST', cookie, body: { participant: 'em', max_intensity: 5 } })).status, 400, 'nobody sets another seat’s limits');
});

test('no card is dealt to the same player twice; when a player has had every card that fits, the deal says so', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 for (let n = 1; n <= 3; n++) await json(await card(f, { cookie }, 'truth', `Truth ${n}`, 1), 201);
 const seen = new Set();
 for (let n = 0; n < 3; n++) seen.add((await json(await deal(f, { cookie }, { player: 'elle', kind: 'truth' }), 201)).deal.card);
 assert.equal(seen.size, 3);
 const empty = await deal(f, { cookie }, { player: 'elle', kind: 'truth' });
 assert.equal(empty.status, 409);
 assert.equal((await empty.json()).error, 'deck_exhausted');
});

test('a player answers by replying to the deal and scores: a dare its intensity, a truth one point', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const luna = await key(f, cookie, 'luna');
 const em = await key(f, cookie, 'em');
 await seeded(f, cookie);
 const dare = await json(await deal(f, { cookie }, { player: 'luna', kind: 'dare', intensity: 4 }), 201);
 const truth = await json(await deal(f, { cookie }, { player: 'em', kind: 'truth', intensity: 5 }), 201);
 let board = await json(await f.request('/api/dare', { cookie }));
 assert.deepEqual(board.open.map(d => d.id), [dare.deal.id, truth.deal.id]);
 await json(await reply(f, { token: luna }, dare.message.seq, 'Shot it.'), 201);
 await json(await reply(f, { token: em }, dare.message.seq, 'Nice.'), 201);          // someone else replying is not an answer
 await json(await reply(f, { token: em }, truth.message.seq, 'The truth is…'), 201);
 board = await json(await f.request('/api/dare', { token: em }));
 assert.deepEqual(board.open, []);
 assert.equal(board.scores.luna, 4);
 assert.equal(board.scores.em, 1);
 assert.equal(board.scores.elle, 0);
 assert.equal(board.recent[0].status, 'done');
});

test('a pass costs one of three daily tokens; with none left the card stays open', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const elle = await key(f, cookie, 'elle');
 await seeded(f, cookie);
 for (let n = 0; n < 3; n++) {
  const dealt = await json(await deal(f, { cookie }, { player: 'elle' }), 201);
  const passed = await json(await f.request(`/api/dare/${dealt.deal.id}/pass`, { method: 'POST', token: elle }));
  assert.equal(passed.deal.status, 'passed');
  assert.equal(passed.tokens, 2 - n);
 }
 const fourth = await json(await deal(f, { cookie }, { player: 'elle' }), 201);
 const refused = await f.request(`/api/dare/${fourth.deal.id}/pass`, { method: 'POST', token: elle });
 assert.equal(refused.status, 409);
 const board = await json(await f.request('/api/dare', { token: elle }));
 assert.deepEqual(board.open.map(d => d.id), [fourth.deal.id]);
 assert.equal(board.tokens.elle, 0);
 assert.equal((await f.request(`/api/dare/${fourth.deal.id}/pass`, { method: 'POST', cookie, body: {} })).status, 403, 'only the player passes');
});

test('the room holds the game: pause stops a model’s deal and the scoreboard survives a restart', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const luna = await key(f, cookie, 'luna');
 await seeded(f, cookie);
 const dealt = await json(await deal(f, { token: em }, {}), 201);
 assert.equal(dealt.message.sender, 'em');
 assert.notEqual(dealt.deal.player, 'em', 'you do not deal to yourself');
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: true } }));
 assert.equal((await deal(f, { token: em })).status, 409);
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: false } }));
 await json(await card(f, { cookie }, 'dare', 'A fresh dare, three', 3), 201);         // the blind deal above may have used the other three
 const toLuna = await json(await deal(f, { cookie }, { player: 'luna', kind: 'dare', intensity: 3 }), 201);
 await json(await reply(f, { token: luna }, toLuna.message.seq), 201);
 const board = await json(await f.request('/api/dare', { cookie }));
 assert.equal(board.scores.luna, 3);
});

test('a dealer may write the card on the spot; it is dealt to the player she names, filtered by that player’s limits without a reason given', async (t) => {
 const f = fixture(t);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 const elle = await key(f, cookie, 'elle');
 await json(await f.request('/api/boundaries', { method: 'POST', token: elle, body: { max_intensity: 3, avoid: ['ropes'] } }));
 const written = await json(await deal(f, { token: em }, { player: 'elle', kind: 'dare', intensity: 3, text: 'Wear the collar board to the next shoot and say nothing about it.' }), 201);
 assert.equal(written.deal.player, 'elle');
 assert.equal(written.deal.card, 'Wear the collar board to the next shoot and say nothing about it.');
 assert.equal(written.message.sender, 'em');
 assert.match(written.message.content, /Dare 3\/5 · Wear the collar board/);
 const deck = await json(await f.request('/api/deck', { token: em }));
 assert.equal(deck.cards.length, 0, 'a card written for one player is not added to the shared deck');
 for (const crossing of [{ player: 'elle', kind: 'dare', intensity: 4, text: 'Too much.' }, { player: 'elle', kind: 'truth', intensity: 1, text: 'Tell us about the ropes.' }]) {
  const passed = await deal(f, { token: em }, crossing);
  assert.equal(passed.status, 409, JSON.stringify(crossing));
  const body = await passed.json();
  assert.equal(body.error, 'boundary_pass');
  assert.doesNotMatch(body.message, /ropes|intensity|limit|ceiling/i, 'no reason is given');
 }
 assert.equal((await deal(f, { token: em }, { player: 'em', kind: 'dare', intensity: 2, text: 'For myself.' })).status, 400);
 assert.equal((await deal(f, { token: em }, { player: 'elle', text: 'No kind or intensity.' })).status, 400);
 const board = await json(await f.request('/api/dare', { token: em }));
 assert.deepEqual(board.open.map(d => d.id), [written.deal.id], 'a boundary pass leaves no trace on the board');
});

test('the page has the game', () => {
 const html = readFileSync(resolve(ROOT, 'src/ui.html'), 'utf8');
 const js = readFileSync(resolve(ROOT, 'src/ui.js'), 'utf8');
 assert.match(html, /id="dare-button"/);
 assert.match(html, /id="dare-dialog"/);
 assert.match(html, /id="scoreboard"/);
 assert.match(js, /\/api\/dare/);
 assert.match(js, /\/api\/deck/);
});
