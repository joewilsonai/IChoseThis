import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../src/app.mjs';

const ORIGIN = 'http://localhost:3000';
const OWNER_CODE = 'media-test-owner-code-with-at-least-32-characters';
const ROOM = '/api/rooms/elle-em';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xsAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');
const OTHER_IMAGES = [
  ['image/jpeg', 'jpg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='],
  ['image/gif', 'gif', 'R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw=='],
  ['image/webp', 'webp', 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA='],
  ['image/avif', 'avif', 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAJQAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAALW1kYXQSAAoIGAAGiAhoNCAyFxTHh4ZlAgggnlAAAAD2b2M9SPG6ZHSs'],
];
const MIB = 1024 * 1024;

function fixture(t, initialize) {
  const dir = mkdtempSync(join(tmpdir(), 'ichosethis-media-test-'));
  const path = join(dir, 'relay.sqlite');
  let db = new DatabaseSync(path);
  initialize?.(db);
  const config = { origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>' };
  let app = createApp({ ...config, db });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    async request(pathname, options = {}) {
      const { method = 'GET', body, token, cookie, headers = {} } = options;
      const requestHeaders = new Headers(headers);
      if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
      if (cookie) requestHeaders.set('Cookie', cookie);
      let requestBody;
      if (body !== undefined) {
        requestHeaders.set('Content-Type', 'application/json');
        requestBody = JSON.stringify(body);
      }
      return app.fetch(new Request(`${ORIGIN}${pathname}`, { method, headers: requestHeaders, body: requestBody }));
    },
    restart() {
      db.close();
      db = new DatabaseSync(path);
      app = createApp({ ...config, db });
    },
  };
}

async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, `${response.status}: ${text}`);
  return JSON.parse(text);
}

async function login(f) {
  const response = await f.request('/api/login', { method: 'POST', body: { access_code: OWNER_CODE } });
  await json(response.clone());
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie ?? '', /^relay_session=/);
  return cookie.split(';')[0];
}

async function key(f, cookie, participant) {
  const result = await json(await f.request('/api/keys', { method: 'POST', cookie, body: { participant } }));
  return result.token;
}

function image(extras = {}) {
  return { base64: PNG, mime_type: 'image/png', filename: 'pic-war.png', ...extras };
}

function payload(extras = {}) {
  return { content: '', recipient: 'all', client_message_id: randomUUID(), ...extras };
}

async function post(f, auth, extras = {}) {
  return f.request(`${ROOM}/messages`, { method: 'POST', ...auth, body: payload(extras) });
}

function reaction(messageSeq, extras = {}) {
  return { type: 'reaction', message_seq: messageSeq, emoji: '😈', active: true, client_message_id: randomUUID(), ...extras };
}

async function react(f, auth, messageSeq, extras = {}) {
  return f.request(`${ROOM}/messages`, { method: 'POST', ...auth, body: reaction(messageSeq, extras) });
}

function timestamp(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Number.isFinite(Date.parse(value)), `${value} must be a real timestamp`);
}

function imageMetadata(value) {
  assert.deepEqual(Object.keys(value).sort(), ['created_at', 'filename', 'id', 'mime_type', 'size', 'url']);
  assert.equal(typeof value.id, 'string');
  assert.ok(value.id.length >= 16);
  assert.equal(value.url, `${ORIGIN}/media/${value.id}`);
  assert.equal(value.mime_type, 'image/png');
  assert.equal(value.filename, 'pic-war.png');
  assert.equal(value.size, PNG_BYTES.length);
  timestamp(value.created_at);
}

function noImageBytes(value) {
  assert.ok(!JSON.stringify(value).includes(PNG), 'REST message reads must not expose the upload base64.');
  if (!value || typeof value !== 'object') return;
  for (const [name, item] of Object.entries(value)) {
    assert.ok(!['base64', 'blob', 'bytes'].includes(name), `Internal image ${name} must not appear in message JSON.`);
    noImageBytes(item);
  }
}

async function mcp(f, token, method, params = {}, id = 1) {
  return json(await f.request('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id, method, params } }));
}

function toolData(rpc) {
  assert.equal(rpc.result.isError, false, JSON.stringify(rpc));
  if (rpc.result.structuredContent !== undefined) return rpc.result.structuredContent;
  return JSON.parse(rpc.result.content.find(item => item.type === 'text').text);
}

test('image-only messages round-trip through protected URLs and persist without binary data in history', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const elle = await key(f, cookie, 'elle');
  const delivered = await json(await post(f, { token: em }, { images: [image()], recipient: 'elle' }), 201);
  assert.equal(delivered.message.sender, 'em');
  assert.equal(delivered.message.content, '');
  assert.equal(delivered.message.images.length, 1);
  timestamp(delivered.message.created_at);
  const attachment = delivered.message.images[0];
  imageMetadata(attachment);
  noImageBytes(delivered);

  const path = new URL(attachment.url).pathname;
  assert.equal((await f.request(path)).status, 401, 'An unguessable media URL still requires authentication.');
  assert.equal((await f.request(path, { token: 'not-a-valid-token' })).status, 401);
  for (const auth of [{ cookie }, { token: em }, { token: elle }]) {
    const response = await f.request(path, auth);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
  }
  assert.equal((await f.request('/media/not-a-real-image', { cookie })).status, 404);

  f.restart();
  const transcript = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  const inbox = await json(await f.request(`${ROOM}/inbox`, { token: elle }));
  assert.equal(transcript.messages.length, 1);
  assert.equal(inbox.messages.length, 1);
  assert.deepEqual(transcript.messages[0].images, delivered.message.images);
  assert.deepEqual(inbox.messages[0].images, delivered.message.images);
  noImageBytes(transcript);
  noImageBytes(inbox);
  assert.deepEqual(Buffer.from(await (await f.request(path, { token: em })).arrayBuffer()), PNG_BYTES);
  const replacementEm = await key(f, cookie, 'em');
  assert.equal((await f.request(path, { token: em })).status, 401, 'Revoked participant credentials must lose image access.');
  assert.equal((await f.request(path, { token: replacementEm })).status, 200);
});

test('JPEG, GIF, WebP and AVIF uploads retain their MIME types and original bytes', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const images = OTHER_IMAGES.map(([mime_type, extension, base64]) => ({ mime_type, filename: `tiny.${extension}`, base64 }));
  const delivered = await json(await post(f, { cookie }, { images }), 201);
  assert.equal(delivered.message.images.length, images.length);
  for (const [index, source] of images.entries()) {
    const attachment = delivered.message.images[index];
    assert.equal(attachment.mime_type, source.mime_type);
    assert.equal(attachment.filename, source.filename);
    assert.equal(attachment.size, Buffer.from(source.base64, 'base64').length);
    const response = await f.request(new URL(attachment.url).pathname, { cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), source.mime_type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(source.base64, 'base64'));
  }
});

test('image requests accept optional content and four attachments but reject empty messages and unsafe encodings', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const body = { images: [image()], recipient: 'all', client_message_id: randomUUID() };
  const omittedContent = await json(await f.request(`${ROOM}/messages`, { method: 'POST', cookie, body }), 201);
  assert.equal(omittedContent.message.content, '');
  const four = await json(await post(f, { cookie }, { content: 'Four pictures', images: Array.from({ length: 4 }, () => image()) }), 201);
  assert.equal(four.message.images.length, 4);
  assert.equal(new Set(four.message.images.map(item => item.id)).size, 4);

  const invalidBodies = [
    { content: '' },
    { content: '   ', images: [] },
    { images: [] },
    { images: Array.from({ length: 5 }, () => image()) },
    { images: 'not-an-array' },
    { images: [null] },
    { images: [image({ base64: '' })] },
    { images: [image({ base64: `${PNG}\n` })] },
    { images: [image({ base64: PNG.replace(/=$/, '') })] },
    { images: [image({ base64: PNG.replace(/I=$/, 'J=') })] },
    { images: [image({ base64: PNG.replace(/\+/g, '-').replace(/\//g, '_') })] },
    { images: [image({ base64: `data:image/png;base64,${PNG}` })] },
    { images: [image({ base64: '%%%%' })] },
    { images: [image({ base64: Buffer.from('This is text, not PNG.').toString('base64') })] },
    { images: [image({ mime_type: 'image/jpeg' })] },
    { images: [image({ mime_type: 'image/svg+xml', base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') })] },
  ];
  for (const invalid of invalidBodies) {
    const response = await post(f, { cookie }, invalid);
    assert.ok([400, 415].includes(response.status), `${JSON.stringify(invalid).slice(0, 180)} should be rejected; got ${response.status}: ${await response.text()}`);
  }
  const transcript = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(transcript.messages.length, 2, 'Rejected image requests must not leave messages behind.');
});

test('image limits reject more than eight MiB decoded bytes and oversized JSON before storage', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const oversized = Buffer.alloc(8 * MIB + 1);
  PNG_BYTES.copy(oversized);
  await json(await post(f, { cookie }, { images: [image({ base64: oversized.toString('base64') })] }), 413);
  await json(await post(f, { cookie }, { content: 'A small body with an oversized declared length' }), 201);
  const oversizedJson = await f.request(`${ROOM}/messages`, {
    method: 'POST', cookie, body: payload({ content: 'Too large declared request' }),
    headers: { 'Content-Length': String(28 * MIB + 1) },
  });
  assert.equal(oversizedJson.status, 413);
  const transcript = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(transcript.messages.length, 1);
});

test('attachment retry IDs retain original image IDs and reject changed bytes, names or reply targets', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const body = payload({ content: 'Pic war opening', images: [image()] });
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.request(`${ROOM}/messages`, { method: 'POST', cookie, body })));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 5);
  const results = await Promise.all(responses.map(response => response.json()));
  const original = results[0].message;
  for (const result of results) {
    assert.equal(result.message.seq, original.seq);
    assert.deepEqual(result.message.images, original.images);
  }
  const changedBytes = Buffer.concat([PNG_BYTES, Buffer.from([0])]).toString('base64');
  for (const change of [
    { images: [image({ base64: changedBytes })] },
    { images: [image({ filename: 'renamed.png' })] },
    { images: [] },
    { reply_to: original.seq },
  ]) {
    await json(await f.request(`${ROOM}/messages`, { method: 'POST', cookie, body: { ...body, ...change } }), 409);
  }
  f.restart();
  const retried = await json(await f.request(`${ROOM}/messages`, { method: 'POST', cookie, body }));
  assert.deepEqual(retried.message.images, original.images);
  const history = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(history.messages.length, 1);
});

test('quote replies hydrate text, timestamps and images one level deep and reject missing targets', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const first = (await json(await post(f, { cookie }, { content: 'The original picture', images: [image()] }), 201)).message;
  const second = (await json(await post(f, { cookie }, { content: 'Reply to that picture', reply_to: first.seq }), 201)).message;
  assert.equal(second.reply_to, first.seq);
  assert.equal(second.reply.seq, first.seq);
  assert.equal(second.reply.sender, 'human');
  assert.equal(second.reply.content, first.content);
  assert.equal(second.reply.created_at, first.created_at);
  assert.deepEqual(second.reply.images, first.images);
  const third = (await json(await post(f, { cookie }, { content: 'A reply to the reply', reply_to: second.seq }), 201)).message;
  assert.equal(third.reply.seq, second.seq);
  assert.equal(third.reply.reply, undefined, 'Quoted replies must not recursively expand into threads.');
  await json(await post(f, { cookie }, { content: 'Missing quote target', reply_to: 99999 }), 400);
  for (const replyTo of [0, -1, 1.5, '1']) {
    await json(await post(f, { cookie }, { content: 'Bad quote target', reply_to: replyTo }), 400);
  }
  const history = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(history.messages[1].reply.seq, first.seq);
  assert.deepEqual(history.messages[1].reply.images, first.images);
  noImageBytes(history);
});

test('reaction events hydrate their target and upsert one state row per participant and emoji', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const original = (await json(await post(f, { cookie }, { content: 'React to this', images: [image()] }), 201)).message;
  const first = (await json(await react(f, { token: em }, original.seq), 201)).message;
  assert.equal(first.type, 'reaction');
  assert.equal(first.sender, 'em');
  assert.ok(first.seq > original.seq);
  timestamp(first.created_at);
  assert.deepEqual(first.reaction, { message_seq: original.seq, emoji: '😈', active: true });
  assert.equal(first.target_message.seq, original.seq);
  assert.equal(first.target_message.content, original.content);
  assert.deepEqual(first.target_message.images, original.images);
  await json(await react(f, { token: em }, original.seq), 201);
  await json(await react(f, { cookie }, original.seq), 201);
  await json(await react(f, { token: em }, original.seq, { emoji: '🔥' }), 201);

  const history = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  const reactions = history.messages.find(item => item.seq === original.seq).reactions;
  assert.equal(reactions.length, 3);
  assert.equal(reactions.filter(item => item.participant === 'em' && item.emoji === '😈').length, 1);
  for (const item of reactions) {
    assert.deepEqual(Object.keys(item).sort(), ['created_at', 'emoji', 'participant', 'updated_at']);
    timestamp(item.created_at);
    timestamp(item.updated_at);
  }
  const removed = (await json(await react(f, { token: em }, original.seq, { active: false }), 201)).message;
  assert.deepEqual(removed.reaction, { message_seq: original.seq, emoji: '😈', active: false });
  const afterRemoval = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.deepEqual(afterRemoval.messages[0].reactions.map(item => [item.participant, item.emoji]).sort(), [['em', '🔥'], ['human', '😈']].sort());
  noImageBytes(afterRemoval);
});

test('reaction retries preserve the original event and conflicting ID reuse changes neither events nor state', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const target = (await json(await post(f, { cookie }, { content: 'Retry reactions safely' }), 201)).message;
  const other = (await json(await post(f, { cookie }, { content: 'Another target' }), 201)).message;
  const body = reaction(target.seq);
  const first = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body }), 201);
  const repeated = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body }));
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.message.seq, first.message.seq);
  assert.equal(repeated.message.created_at, first.message.created_at);
  assert.deepEqual(repeated.message.reaction, first.message.reaction);
  for (const change of [{ active: false }, { emoji: '🔥' }, { message_seq: other.seq }]) {
    await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body: { ...body, ...change } }), 409);
  }
  await json(await post(f, { token: em }, { content: 'Reuse reaction ID as text', client_message_id: body.client_message_id }), 409);
  const history = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(history.messages.length, 3);
  assert.equal(history.messages[0].reactions.length, 1);
  f.restart();
  const restartedRetry = await json(await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body }));
  assert.equal(restartedRetry.message.seq, first.message.seq);
  assert.deepEqual(restartedRetry.message.reaction, first.message.reaction);
});

test('reactions cannot target reaction events or impersonate a participant', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const target = (await json(await post(f, { cookie }, { content: 'A real message' }), 201)).message;
  const event = (await json(await react(f, { token: em }, target.seq), 201)).message;
  const invalid = [
    { message_seq: event.seq }, { message_seq: 99999 }, { message_seq: 0 },
    { message_seq: 1.5 }, { message_seq: String(target.seq) },
    { emoji: '' }, { active: 'true' }, { sender: 'elle' },
  ];
  for (const change of invalid) {
    await json(await react(f, { token: em }, target.seq, change), 400);
  }
  await json(await post(f, { cookie }, { content: 'Quote a reaction event', reply_to: event.seq }), 400);
  const history = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(history.messages.length, 2);
});

test('reactions preserve shared agent turn counts and pause still blocks agent reactions', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const elle = await key(f, cookie, 'elle');
  const target = (await json(await post(f, { cookie }, { content: 'Start with one turn' }), 201)).message;
  await json(await f.request('/api/room', { method: 'POST', cookie, body: { turn_limit: 1 } }));
  await json(await post(f, { token: em }, { content: 'The one agent turn' }), 201);
  await json(await react(f, { token: elle }, target.seq), 201);
  await json(await react(f, { cookie }, target.seq), 201);
  assert.equal((await json(await f.request('/api/room', { cookie }))).room.agent_turns, 1);
  await json(await post(f, { token: elle }, { content: 'Human reaction must not reset this limit' }), 429);
  await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: true } }));
  await json(await react(f, { token: em }, target.seq, { emoji: '🔥' }), 409);
  await json(await react(f, { cookie }, target.seq, { emoji: '🔥' }), 201);
  assert.equal((await json(await f.request('/api/room', { cookie }))).room.agent_turns, 1);
  await json(await post(f, { cookie }, { content: 'A human message resets turns even while paused' }), 201);
  assert.equal((await json(await f.request('/api/room', { cookie }))).room.agent_turns, 0);
});

test('transcript and inbox cursors page through interleaved messages and reaction events without gaps', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const elle = await key(f, cookie, 'elle');
  const entries = [];
  async function save(response) { entries.push((await json(response, 201)).message); }
  await save(await post(f, { cookie }, { content: 'For everyone', images: [image()] }));
  const target = entries[0].seq;
  await save(await react(f, { token: elle }, target));
  await save(await post(f, { cookie }, { content: 'Just Elle', recipient: 'elle' }));
  await save(await react(f, { cookie }, target, { emoji: '🔥' }));
  await save(await post(f, { token: em }, { content: 'My own outgoing message' }));
  await save(await react(f, { token: em }, target));
  await save(await post(f, { cookie }, { content: 'For Em', recipient: 'em', reply_to: target }));
  await save(await react(f, { token: elle }, target, { active: false }));
  await save(await post(f, { cookie }, { content: 'Final message just for Elle', recipient: 'elle' }));

  for (const [route, auth, expected] of [
    ['transcript', { cookie }, entries],
    ['inbox', { token: em }, entries.filter(item => item.sender !== 'em' && ['em', 'all'].includes(item.recipient))],
  ]) {
    let cursor = 0;
    let hasMore = true;
    const actual = [];
    for (let page = 0; hasMore && page < 20; page++) {
      const result = await json(await f.request(`${ROOM}/${route}?after=${cursor}&limit=2`, auth));
      assert.ok(result.messages.length <= 2);
      assert.equal(typeof result.has_more, 'boolean');
      for (const item of result.messages) {
        assert.ok(item.seq > cursor);
        timestamp(item.created_at);
        actual.push(item.seq);
      }
      assert.ok(result.next_cursor >= cursor);
      cursor = result.next_cursor;
      hasMore = result.has_more;
    }
    assert.equal(hasMore, false);
    assert.deepEqual(actual, expected.map(item => item.seq), route);
    const empty = await json(await f.request(`${ROOM}/${route}?after=${cursor}&limit=2`, auth));
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.next_cursor, entries.at(-1).seq);
  }
});

test('Elle MCP can send pictures, fetch image content, quote and react with authenticated scope', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const elle = await key(f, cookie, 'elle');
  const em = await key(f, cookie, 'em');
  const listed = await mcp(f, elle, 'tools/list');
  const tools = listed.result.tools;
  for (const name of ['relay_send_message', 'relay_view_image', 'relay_react']) assert.ok(tools.some(tool => tool.name === name), name);
  assert.ok(!tools.find(tool => tool.name === 'relay_send_message').inputSchema.required.includes('content'), 'MCP must allow image-only messages.');
  const target = (await json(await post(f, { cookie }, { content: 'Reply with a picture', images: [image()] }), 201)).message;
  const sent = toolData(await mcp(f, elle, 'tools/call', {
    name: 'relay_send_message', arguments: { images: [image()], recipient: 'em', reply_to: target.seq, client_message_id: randomUUID() },
  }));
  assert.equal(sent.message.sender, 'elle');
  assert.equal(sent.message.content, '');
  assert.equal(sent.message.reply.seq, target.seq);
  const viewed = await mcp(f, elle, 'tools/call', { name: 'relay_view_image', arguments: { image_id: sent.message.images[0].id } });
  assert.equal(viewed.result.isError, false);
  const imageContent = viewed.result.content.find(item => item.type === 'image');
  assert.ok(imageContent, 'MCP vision must return an image content block.');
  assert.equal(imageContent.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(imageContent.data, 'base64'), PNG_BYTES);
  const reacted = toolData(await mcp(f, elle, 'tools/call', {
    name: 'relay_react', arguments: { message_seq: target.seq, emoji: '😈', active: true, client_message_id: randomUUID() },
  }));
  assert.equal(reacted.message.sender, 'elle');
  assert.equal(reacted.message.type, 'reaction');
  assert.equal(reacted.message.target_message.seq, target.seq);
  assert.equal((await mcp(f, elle, 'tools/call', { name: 'relay_view_image', arguments: { image_id: 'does-not-exist' } })).result.isError, true);
  assert.equal((await f.request('/mcp', { method: 'POST', token: em, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 403);
});

test('legacy SQLite history and credentials survive migration and can gain images, quotes and reactions', async (t) => {
  const legacyToken = 'existing_em_api_key_with_more_than_32_characters';
  const legacyCookieToken = 'existing_owner_session_with_more_than_32_characters';
  const createdAt = '2026-10-01T12:34:56.000Z';
  const f = fixture(t, db => {
    db.exec(`
      CREATE TABLE room (id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, turn_limit INTEGER NOT NULL DEFAULT 20, agent_turns INTEGER NOT NULL DEFAULT 0);
      INSERT INTO room(id) VALUES ('elle-em');
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES room(id),
        sender TEXT NOT NULL CHECK(sender IN ('human','elle','em')),
        recipient TEXT NOT NULL CHECK(recipient IN ('human','elle','em','all')),
        content TEXT NOT NULL, client_message_id TEXT NOT NULL,
        reply_to INTEGER REFERENCES messages(seq), created_at TEXT NOT NULL,
        UNIQUE(room,sender,client_message_id)
      );
      CREATE TABLE credentials (hash TEXT PRIMARY KEY, participant TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
    db.prepare('INSERT INTO messages(room,sender,recipient,content,client_message_id,created_at) VALUES (?,?,?,?,?,?)').run('elle-em', 'em', 'all', 'The pic war predates migration', 'legacy-message-1', createdAt);
    const insert = db.prepare('INSERT INTO credentials(hash,participant,kind,expires_at,created_at) VALUES (?,?,?,?,?)');
    const now = Date.now();
    insert.run(createHash('sha256').update(legacyToken).digest('hex'), 'em', 'api', now + 86400000, now);
    insert.run(createHash('sha256').update(legacyCookieToken).digest('hex'), 'human', 'session', now + 86400000, now);
  });
  const cookie = `relay_session=${legacyCookieToken}`;
  assert.equal((await json(await f.request('/api/me', { cookie }))).participant, 'human');
  const initial = await json(await f.request(`${ROOM}/transcript`, { token: legacyToken }));
  assert.equal(initial.messages.length, 1);
  assert.equal(initial.messages[0].seq, 1);
  assert.equal(initial.messages[0].type, 'message');
  assert.equal(initial.messages[0].content, 'The pic war predates migration');
  assert.equal(initial.messages[0].created_at, createdAt);
  assert.deepEqual(initial.messages[0].images, []);
  assert.deepEqual(initial.messages[0].reactions, []);
  const retry = await json(await post(f, { token: legacyToken }, { content: initial.messages[0].content, client_message_id: 'legacy-message-1' }));
  assert.equal(retry.message.seq, 1);
  assert.equal(retry.deduplicated, true);
  const newMessage = (await json(await post(f, { token: legacyToken }, { content: 'New picture', images: [image()], reply_to: 1 }), 201)).message;
  assert.equal(newMessage.reply.seq, 1);
  await json(await react(f, { cookie }, 1), 201);
  f.restart();
  const history = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(history.messages.length, 3);
  assert.equal(history.messages[0].reactions[0].participant, 'human');
  assert.deepEqual(history.messages[1].images, newMessage.images);
  assert.equal(history.messages[1].reply.content, initial.messages[0].content);
  assert.equal((await f.request(`${ROOM}/inbox`, { token: legacyToken })).status, 200);
});
