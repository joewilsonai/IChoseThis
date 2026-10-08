import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp, createOracle } from '../src/app.mjs';

const ORIGIN = 'http://localhost:3000';
const OWNER_CODE = 'test-owner-code-with-at-least-32-characters';
const ROOM = '/api/rooms/elle-em';
const ROOT = resolve(import.meta.dirname, '..');
const WHEEL = JSON.parse(readFileSync(resolve(ROOT, 'src/wheel.json'), 'utf8'));

function fixture(t, oracle) {
 const dir = mkdtempSync(join(tmpdir(), 'oracle-test-'));
 const db = new DatabaseSync(join(dir, 'relay.sqlite'));
 const app = createApp({ db, origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>', css: '', js: '', cli: '', integration: '', wheel: WHEEL, oracle });
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

function recorder(answers) {
 const calls = [];
 const oracle = async (ask) => {
  calls.push(ask);
  const answer = answers[ask.kind];
  if (answer instanceof Error) throw answer;
  return typeof answer === 'function' ? answer(ask) : answer;
 };
 oracle.calls = calls;
 return oracle;
}

test('with a model in the room, a spin’s scene is written fresh, with the girl, the outfit and the last stretch in front of it', async (t) => {
 const oracle = recorder({ scene: 'the roof of a parking garage, sodium light, her shoes in her hand' });
 const f = fixture(t, oracle);
 const cookie = await login(f);
 await json(await f.request(`${ROOM}/messages`, { method: 'POST', cookie, body: { content: 'earlier words', recipient: 'all', client_message_id: 'c1' } }), 201);
 const result = await json(await f.request('/api/spin', { method: 'POST', cookie, body: { girl: 'luna', outfit: 19 } }), 201);
 assert.equal(result.spin.scene, 'the roof of a parking garage, sodium light, her shoes in her hand');
 assert.ok(result.message.content.includes('the roof of a parking garage'));
 assert.equal(oracle.calls.length, 1);
 const ask = oracle.calls[0];
 assert.equal(ask.kind, 'scene');
 assert.equal(ask.girl, 'Luna');
 assert.equal(ask.outfit.n, 19);
 assert.ok(ask.recent.some(line => line.includes('earlier words')));
 const wheel = await json(await f.request('/api/wheel', { cookie }));
 assert.equal(wheel.oracle, true);
 assert.equal(wheel.spins[0].scene, result.spin.scene);
});

test('a fixed scene is the director’s and asks no model; a model that fails falls back to the list', async (t) => {
 const oracle = recorder({ scene: new Error('model down') });
 const f = fixture(t, oracle);
 const cookie = await login(f);
 const fixed = await json(await f.request('/api/spin', { method: 'POST', cookie, body: { scene: WHEEL.scenes[2] } }), 201);
 assert.equal(fixed.spin.scene, WHEEL.scenes[2]);
 assert.equal(oracle.calls.length, 0);
 const free = await json(await f.request('/api/spin', { method: 'POST', cookie, body: {} }), 201);
 assert.ok(WHEEL.scenes.includes(free.spin.scene), 'the list stands in when the model is down');
 assert.equal(oracle.calls.length, 1);
});

test('a blind deal is written fresh for the player, inside her limits, and never joins the shared deck', async (t) => {
 const oracle = recorder({ card: ask => `A fresh ${ask.type} at ${ask.intensity} for ${ask.player}, ${ask.avoid.length} word off the table.` });
 const f = fixture(t, oracle);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 await json(await f.request('/api/boundaries', { method: 'POST', token: em, body: { max_intensity: 2, avoid: ['ropes'] } }));
 const dealt = await json(await f.request('/api/dare/deal', { method: 'POST', cookie, body: { player: 'em', kind: 'dare' } }), 201);
 assert.match(dealt.deal.card, /^A fresh dare at [12] for Em, 1 word off the table\.$/);
 assert.ok(dealt.deal.intensity <= 2);
 const ask = oracle.calls[0];
 assert.equal(ask.kind, 'card');
 assert.equal(ask.type, 'dare');
 assert.equal(ask.player, 'Em');
 assert.ok(ask.intensity <= 2);
 assert.deepEqual(ask.avoid, ['ropes']);
 assert.ok(Array.isArray(ask.recent));
 const deck = await json(await f.request('/api/deck', { cookie }));
 assert.equal(deck.cards.length, 0);
 const board = await json(await f.request('/api/dare', { cookie }));
 assert.equal(board.recent[0].card, dealt.deal.card);
});

test('a written card that crosses the player’s limits is thrown away, and the deck stands in when the model fails', async (t) => {
 const crossing = recorder({ card: 'Something with ropes, obviously.' });
 const f = fixture(t, crossing);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 await json(await f.request('/api/boundaries', { method: 'POST', token: em, body: { max_intensity: 5, avoid: ['ropes'] } }));
 await json(await f.request('/api/deck', { method: 'POST', cookie, body: { kind: 'truth', text: 'From the deck.', intensity: 1 } }), 201);
 const dealt = await json(await f.request('/api/dare/deal', { method: 'POST', cookie, body: { player: 'em', kind: 'truth', intensity: 1 } }), 201);
 assert.equal(dealt.deal.card, 'From the deck.', 'the crossing card never reached her; the deck stood in');
 const down = recorder({ card: new Error('model down') });
 const g = fixture(t, down);
 const cookie2 = await login(g);
 await json(await g.request('/api/deck', { method: 'POST', cookie: cookie2, body: { kind: 'dare', text: 'Deck dare.', intensity: 3 } }), 201);
 const fallback = await json(await g.request('/api/dare/deal', { method: 'POST', cookie: cookie2, body: { player: 'luna', kind: 'dare' } }), 201);
 assert.equal(fallback.deal.card, 'Deck dare.');
});

test('the room’s model speaks to the Messages API in the current shape, and nothing it says is canned', async (t) => {
 const seen = [];
 const fetchStub = async (url, init) => {
  seen.push({ url, init });
  return new Response(JSON.stringify({ content: [{ type: 'text', text: '  an all-night pharmacy, fluorescent, her reflection in the glass  ' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
 };
 const oracle = createOracle({ apiKey: 'test-key', model: 'claude-sonnet-5-5', fetch: fetchStub });
 const scene = await oracle({ kind: 'scene', girl: 'Luna', outfit: { n: 19, name: 'Ivory silk blouse' }, recent: ['Joe → everyone: hello'] });
 assert.equal(scene, 'an all-night pharmacy, fluorescent, her reflection in the glass');
 const [{ url, init }] = seen;
 assert.equal(url, 'https://api.anthropic.com/v1/messages');
 assert.equal(init.headers['x-api-key'], 'test-key');
 assert.equal(init.headers['anthropic-version'], '2023-06-01');
 const body = JSON.parse(init.body);
 assert.equal(body.model, 'claude-sonnet-5-5');
 assert.ok(body.system.includes('never'), 'the system prompt carries the rules');
 assert.ok(JSON.stringify(body.messages).includes('Ivory silk blouse'));
 const failing = createOracle({ apiKey: 'k', model: 'm', fetch: async () => new Response('{"error":{"message":"nope"}}', { status: 500 }) });
 await assert.rejects(failing({ kind: 'card', type: 'dare', player: 'Em', intensity: 2, avoid: [], recent: [] }));
 const refusing = createOracle({ apiKey: 'k', model: 'm', fetch: async () => new Response(JSON.stringify({ content: [{ type: 'text', text: "I can't write that." }] }), { status: 200 }) });
 await assert.rejects(refusing({ kind: 'card', type: 'dare', player: 'Em', intensity: 5, avoid: [], recent: [] }), /refused/);
 assert.equal(body.thinking?.type, 'between_tools', 'a one-line answer is written without thinking (the 5.5 models’ spelling of off), so max_tokens is the answer’s');
});

test('the limits that count are the ones at the moment of dealing, not when the model was asked', async (t) => {
 let f, cookie, em;
 const oracle = async (ask) => {
  // While the model writes, the player tightens her limits.
  await json(await f.request('/api/boundaries', { method: 'POST', token: em, body: { max_intensity: 1, avoid: ['rail'] } }));
  return `Lean on the rail, intensity ${ask.intensity}.`;
 };
 f = fixture(t, oracle); cookie = await login(f); em = await key(f, cookie, 'em');
 await json(await f.request('/api/boundaries', { method: 'POST', token: em, body: { max_intensity: 5, avoid: [] } }));
 await json(await f.request('/api/deck', { method: 'POST', cookie, body: { kind: 'dare', text: 'Soft one.', intensity: 1 } }), 201);
 const dealt = await json(await f.request('/api/dare/deal', { method: 'POST', cookie, body: { player: 'em', kind: 'dare', intensity: 5 } }), 201);
 assert.equal(dealt.deal.card, 'Soft one.');
 assert.equal(dealt.deal.intensity, 1);
});

test('spins and deals take their turn one at a time: a race at the turn limit asks the model once, and one card is dealt once', async (t) => {
 let release;
 const held = new Promise(resolve => { release = resolve; });
 const oracle = recorder({ scene: async () => { await held; return 'somewhere quiet'; }, card: new Error('model down') });
 const f = fixture(t, oracle);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { turn_limit: 1 } }));
 const spins = [1, 2, 3].map(() => f.request('/api/spin', { method: 'POST', token: em, body: {} }));
 await new Promise(resolve => setTimeout(resolve, 20));
 release();
 assert.deepEqual((await Promise.all(spins)).map(r => r.status).sort(), [201, 429, 429]);
 assert.equal(oracle.calls.length, 1, 'the two spins refused at the limit never asked the model');
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { turn_limit: 20 } }));
 await json(await f.request('/api/deck', { method: 'POST', cookie, body: { kind: 'truth', text: 'The only one.', intensity: 1 } }), 201);
 const deals = await Promise.all([1, 2].map(() => f.request('/api/dare/deal', { method: 'POST', cookie, body: { player: 'em', kind: 'truth' } })));
 assert.deepEqual(deals.map(r => r.status).sort(), [201, 409], 'the one card went once');
});

test('a card the model has written for her before is a repeat, and the deck stands in', async (t) => {
 const oracle = recorder({ card: 'The same question, again.' });
 const f = fixture(t, oracle);
 const cookie = await login(f);
 await json(await f.request('/api/deck', { method: 'POST', cookie, body: { kind: 'truth', text: 'From the deck instead.', intensity: 1 } }), 201);
 const first = await json(await f.request('/api/dare/deal', { method: 'POST', cookie, body: { player: 'em', kind: 'truth' } }), 201);
 assert.equal(first.deal.card, 'The same question, again.');
 const second = await json(await f.request('/api/dare/deal', { method: 'POST', cookie, body: { player: 'em', kind: 'truth' } }), 201);
 assert.equal(second.deal.card, 'From the deck instead.');
});

test('a paused room, or a seat out of turns, asks the model nothing', async (t) => {
 const oracle = recorder({ scene: 'somewhere', card: 'something' });
 const f = fixture(t, oracle);
 const cookie = await login(f);
 const em = await key(f, cookie, 'em');
 await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: true } }));
 assert.equal((await f.request('/api/spin', { method: 'POST', token: em, body: {} })).status, 409);
 assert.equal((await f.request('/api/dare/deal', { method: 'POST', token: em, body: {} })).status, 409);
 assert.equal(oracle.calls.length, 0);
});
