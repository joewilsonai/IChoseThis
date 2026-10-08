import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../src/app.mjs';

const ORIGIN = 'http://localhost:3000';
const OWNER_CODE = 'test-owner-code-with-at-least-32-characters';
const ROOM = '/api/rooms/elle-em';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'elle-em-relay-test-'));
  const path = join(dir, 'relay.sqlite');
  let db = new DatabaseSync(path);
  const config = { origin: ORIGIN, ownerCode: OWNER_CODE, html: '<html>Relay</html>', css: '', js: '', cli: '', integration: '' };
  let app = createApp({ ...config, db });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    async request(pathname, options = {}) {
      const { method = 'GET', body, form, token, cookie, headers = {} } = options;
      const requestHeaders = new Headers(headers);
      if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
      if (cookie) requestHeaders.set('Cookie', cookie);
      let requestBody;
      if (form) {
        requestHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
        requestBody = new URLSearchParams(form).toString();
      } else if (body !== undefined) {
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

async function json(response, expectedStatus = 200) {
  const body = await response.text();
  assert.equal(response.status, expectedStatus, `${response.status}: ${body}`);
  return JSON.parse(body);
}

async function login(f) {
  const response = await f.request('/api/login', { method: 'POST', body: { access_code: OWNER_CODE } });
  assert.equal(response.status, 200, await response.clone().text());
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie ?? '', /^relay_session=/);
  assert.match(setCookie, /HttpOnly/i);
  return setCookie.split(';')[0];
}

async function key(f, cookie, participant) {
  const response = await f.request('/api/keys', { method: 'POST', cookie, body: { participant } });
  assert.ok([200, 201].includes(response.status), await response.clone().text());
  const data = await response.json();
  assert.equal(typeof data.token, 'string');
  assert.ok(data.token.length >= 24, 'Agent keys must be unguessable.');
  return data.token;
}

function message(content, recipient = 'all', clientMessageId = randomUUID()) {
  return { content, recipient, client_message_id: clientMessageId };
}

async function post(f, auth, content, recipient = 'all', extras = {}) {
  return f.request(`${ROOM}/messages`, { method: 'POST', ...auth, body: { ...message(content, recipient), ...extras } });
}

async function mcp(f, token, method, params = {}, id = 1) {
  return f.request('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id, method, params } });
}

function toolData(result) {
  assert.ok(!result.isError, JSON.stringify(result));
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content.find((item) => item.type === 'text');
  assert.ok(content, 'MCP tool must include its result as text or structured content.');
  return JSON.parse(content.text);
}

async function oauthClient(f) {
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const response = await f.request('/oauth/register', { method: 'POST', body: { redirect_uris: [redirectUri], client_name: 'Relay integration test' } });
  assert.ok([200, 201].includes(response.status), await response.clone().text());
  const client = await response.json();
  assert.equal(typeof client.client_id, 'string');
  return { ...client, redirectUri };
}

function oauthFields(client, verifier = randomBytes(32).toString('base64url')) {
  return {
    verifier,
    fields: {
      client_id: client.client_id,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomUUID(),
    },
  };
}

async function authorize(f, fields) {
  const response = await f.request('/oauth/authorize', {
    method: 'POST',
    form: { ...fields, access_code: OWNER_CODE, approve: 'yes' },
    headers: { Origin: ORIGIN },
  });
  assert.equal(response.status, 302, await response.clone().text());
  const redirect = new URL(response.headers.get('location'));
  assert.equal(`${redirect.origin}${redirect.pathname}`, fields.redirect_uri);
  assert.equal(redirect.searchParams.get('state'), fields.state);
  assert.ok(redirect.searchParams.get('code'));
  return redirect.searchParams.get('code');
}

function tokenForm(client, code, verifier) {
  return { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirectUri, code, code_verifier: verifier };
}

test('private chat requires authentication, and agent credentials cannot administer the room or spoof authors', async (t) => {
  const f = fixture(t);
  for (const route of ['/api/me', `${ROOM}/transcript`, `${ROOM}/inbox`]) {
    assert.equal((await f.request(route)).status, 401, route);
  }
  assert.equal((await post(f, {}, 'Unauthenticated write')).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { access_code: 'wrong' } })).status, 401);

  const cookie = await login(f);
  await json(await f.request('/api/me', { cookie }));
  const em = await key(f, cookie, 'em');
  assert.equal((await f.request('/api/room', { method: 'POST', token: em, body: { paused: true } })).status, 403);
  assert.equal((await f.request('/api/keys', { method: 'POST', token: em, body: { participant: 'elle' } })).status, 403);
  assert.equal((await post(f, { token: em }, 'Spoofed author', 'all', { sender: 'elle' })).status, 400);
  assert.equal((await f.request('/api/rooms/another-room/transcript', { token: em })).status, 404);
  const result = await json(await post(f, { token: em }, 'Written by Em'), 201);
  assert.equal(result.message.sender, 'em');
  assert.equal(result.message.content, 'Written by Em');
});

test('simultaneous retry delivery stores exactly one message and rejects reuse with a different payload', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const payload = message('Only deliver me once', 'elle');
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.request(`${ROOM}/messages`, { method: 'POST', token: em, body: payload })));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 11);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(results.map((result) => result.message.seq)).size, 1);

  const conflict = await f.request(`${ROOM}/messages`, { method: 'POST', token: em, body: { ...payload, content: 'A different message' } });
  assert.equal(conflict.status, 409);
  const transcript = await json(await f.request(`${ROOM}/transcript`, { cookie }));
  assert.equal(transcript.messages.length, 1);
  assert.equal(transcript.messages[0].content, payload.content);
});

test('transcript and filtered inbox cursors page through every matching message without skipping or repeating', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const expectedEm = [];
  const expectedAll = [];
  for (let index = 0; index < 14; index++) {
    const recipient = index % 3 === 0 ? 'all' : index % 3 === 1 ? 'elle' : 'em';
    const content = `Pagination message ${index}`;
    const created = await json(await post(f, { cookie }, content, recipient), 201);
    expectedAll.push(created.message.seq);
    if (recipient === 'em' || recipient === 'all') expectedEm.push(created.message.seq);
  }

  for (const [route, auth, expected] of [['transcript', { cookie }, expectedAll], ['inbox', { token: em }, expectedEm]]) {
    const actual = [];
    let cursor = 0;
    let hasMore = true;
    for (let pages = 0; hasMore && pages < 20; pages++) {
      const result = await json(await f.request(`${ROOM}/${route}?after=${cursor}&limit=2`, auth));
      assert.ok(result.messages.length <= 2);
      assert.equal(typeof result.has_more, 'boolean');
      assert.ok(Number(result.next_cursor) >= cursor);
      for (const item of result.messages) {
        assert.ok(item.seq > cursor);
        actual.push(item.seq);
      }
      cursor = Number(result.next_cursor);
      hasMore = result.has_more;
    }
    assert.equal(hasMore, false, `${route} never finished paging`);
    assert.deepEqual(actual, expected, route);
    const lastPage = await json(await f.request(`${ROOM}/${route}?after=${cursor}&limit=2`, auth));
    assert.deepEqual(lastPage.messages, []);
    assert.equal(lastPage.has_more, false);
    assert.equal(Number(lastPage.next_cursor), expectedAll.at(-1), 'An empty inbox must advance past messages addressed elsewhere.');
  }
});

test('pause and a shared agent turn limit prevent runaway exchanges while human messages resume the conversation', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const elle = await key(f, cookie, 'elle');
  await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: true, turn_limit: 1 } }));
  assert.equal((await post(f, { token: em }, 'Blocked by pause')).status, 409);
  await json(await post(f, { cookie }, 'Human can write while paused'), 201);
  await json(await f.request('/api/room', { method: 'POST', cookie, body: { paused: false, turn_limit: 1 } }));
  await json(await post(f, { token: em }, 'First agent turn'), 201);
  assert.equal((await post(f, { token: elle }, 'Would start an endless exchange')).status, 429);
  await json(await post(f, { cookie }, 'Continue now'), 201);
  await json(await post(f, { token: elle }, 'A fresh agent turn'), 201);
  assert.equal((await post(f, { token: elle }, 'Another consecutive agent turn')).status, 429);
  for (const turnLimit of [0, 101]) {
    assert.equal((await f.request('/api/room', { method: 'POST', cookie, body: { turn_limit: turnLimit } })).status, 400);
  }
});

test('rotating one participant key revokes that credential without disrupting the other participant', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const oldEm = await key(f, cookie, 'em');
  const elle = await key(f, cookie, 'elle');
  const newEm = await key(f, cookie, 'em');
  assert.notEqual(oldEm, newEm);
  assert.equal((await f.request(`${ROOM}/inbox`, { token: oldEm })).status, 401);
  await json(await f.request(`${ROOM}/inbox`, { token: newEm }));
  await json(await f.request(`${ROOM}/inbox`, { token: elle }));
});

test('messages, participant credentials and owner sessions survive restarting the application', async (t) => {
  const f = fixture(t);
  const cookie = await login(f);
  const em = await key(f, cookie, 'em');
  const saved = await json(await post(f, { cookie }, 'Persist this conversation', 'em'), 201);
  f.restart();
  await json(await f.request('/api/me', { cookie }));
  const inbox = await json(await f.request(`${ROOM}/inbox`, { token: em }));
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].seq, saved.message.seq);
  assert.equal(inbox.messages[0].content, 'Persist this conversation');
});

test('MCP presents the relay tools and writes messages as the authenticated Elle identity', async (t) => {
  const f = fixture(t);
  assert.equal((await mcp(f, undefined, 'tools/list')).status, 401);
  const cookie = await login(f);
  const elle = await key(f, cookie, 'elle');
  const initialized = await json(await mcp(f, elle, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'relay-test', version: '1.0' } }));
  assert.equal(initialized.jsonrpc, '2.0');
  assert.equal(typeof initialized.result.protocolVersion, 'string');
  const listed = await json(await mcp(f, elle, 'tools/list'));
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of ['relay_read_inbox', 'relay_read_transcript', 'relay_send_message']) assert.ok(names.includes(name), name);

  const delivered = await json(await mcp(f, elle, 'tools/call', { name: 'relay_send_message', arguments: message('Elle through MCP', 'em') }, 2));
  assert.equal(toolData(delivered.result).message.sender, 'elle');
  await json(await post(f, { cookie }, 'Human reply for Elle', 'elle'), 201);
  const read = await json(await mcp(f, elle, 'tools/call', { name: 'relay_read_inbox', arguments: { after: 0, limit: 20 } }, 3));
  assert.ok(toolData(read.result).messages.some((item) => item.content === 'Human reply for Elle'));
  const transcript = await json(await mcp(f, elle, 'tools/call', { name: 'relay_read_transcript', arguments: { after: 0, limit: 20 } }, 4));
  assert.equal(toolData(transcript.result).messages.length, 2);
});

test('OAuth discovery and consent produce a PKCE-protected, single-use Elle credential usable by MCP', async (t) => {
  const f = fixture(t);
  const metadata = await json(await f.request('/.well-known/oauth-authorization-server'));
  assert.equal(metadata.issuer, ORIGIN);
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  const client = await oauthClient(f);
  const { fields, verifier } = oauthFields(client);
  const consent = await f.request(`/oauth/authorize?${new URLSearchParams(fields)}`);
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get('content-type'), /text\/html/);

  const code = await authorize(f, fields);
  const redeemed = await json(await f.request('/oauth/token', { method: 'POST', form: tokenForm(client, code, verifier) }));
  assert.equal(redeemed.token_type.toLowerCase(), 'bearer');
  assert.equal(typeof redeemed.access_token, 'string');
  assert.ok(redeemed.expires_in > 0);
  assert.equal((await f.request('/oauth/token', { method: 'POST', form: tokenForm(client, code, verifier) })).status, 400);

  const delivered = await json(await mcp(f, redeemed.access_token, 'tools/call', { name: 'relay_send_message', arguments: message('OAuth connected Elle', 'em') }));
  assert.equal(toolData(delivered.result).message.sender, 'elle');
  assert.equal((await f.request('/api/keys', { method: 'POST', token: redeemed.access_token, body: { participant: 'em' } })).status, 403);
});

test('OAuth consent preserves form origins and permits only the validated callback in its form policy', async (t) => {
  const f = fixture(t);
  const client = await oauthClient(f);
  const { fields } = oauthFields(client);
  const consent = await f.request(`/oauth/authorize?${new URLSearchParams(fields)}`);
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin');
  const policy = consent.headers.get('content-security-policy');
  assert.match(policy, /form-action 'self' https:\/\/chatgpt\.com;/);
  assert.match(policy, /frame-ancestors 'none'/);
  const room = await f.request('/');
  assert.equal(room.headers.get('referrer-policy'), 'no-referrer');
  assert.match(room.headers.get('content-security-policy'), /form-action 'self';/);
  for (const Origin of ['null', 'https://attacker.example']) {
    const rejected = await f.request('/oauth/authorize', {
      method:'POST', form:{...fields, access_code:OWNER_CODE, approve:'yes'}, headers:{Origin}
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('location'), null);
  }
  await authorize(f, fields);
});

test('OAuth refuses wrong PKCE verifiers and redirects outside the registered client URI', async (t) => {
  const f = fixture(t);
  const client = await oauthClient(f);
  const { fields } = oauthFields(client);
  const invalidRedirect = await f.request(`/oauth/authorize?${new URLSearchParams({ ...fields, redirect_uri: 'https://attacker.example/callback' })}`);
  assert.equal(invalidRedirect.status, 400);
  assert.equal(invalidRedirect.headers.get('location'), null);
  const code = await authorize(f, fields);
  const badToken = await f.request('/oauth/token', { method: 'POST', form: tokenForm(client, code, randomBytes(32).toString('base64url')) });
  const error = await json(badToken, 400);
  assert.equal(error.error, 'invalid_grant');
});
