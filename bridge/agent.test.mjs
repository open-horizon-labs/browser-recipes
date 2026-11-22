import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accessToken, callbackValues, jsonRequest, plan, readResponse, signIn, signOut } from './agent.mjs';

const AUTH = 'https://auth.openai.com';
const JWKS = AUTH + '/.well-known/jwks.json';
const CLIENT = 'oaiapp_browser_recipes_test';
const ISSUER = { issuer: AUTH, jwks_uri: JWKS };
const APP = fileURLToPath(new URL('./browser-recipes-agent', import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key' };

function identity(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'RS256', kid: key.kid }) + '.' + encode(claims);
  return data + '.' + sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
}

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'browser-recipes-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function nativeRequest(path, env, extensionId, request) {
  return new Promise((resolve, reject) => {
    const process = spawn(path, [`chrome-extension://${extensionId}/`], { env });
    const body = Buffer.from(JSON.stringify(request));
    const frame = Buffer.alloc(4);
    frame[endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](body.length);
    process.stdin.write(Buffer.concat([frame, body])); // Chrome keeps the pipe open waiting for the response.
    const output = [];
    process.stdout.on('data', chunk => output.push(chunk));
    process.once('error', reject);
    process.once('exit', code => {
      if (code !== 0) return reject(new Error('Native host exited ' + code));
      resolve(JSON.parse(Buffer.concat(output).subarray(4)));
    });
  });
}

test('installs only the selected extension and speaks native messaging', async t => {
  const root = temporary(t);
  const extensionId = 'a'.repeat(32);
  const env = { ...process.env, XDG_CONFIG_HOME: root };
  const installed = spawnSync(APP, ['install', extensionId, '--browser', 'browseros-neo'], { env, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const manifest = installed.stdout.trim();
  assert.equal(manifest, join(root, 'browser-claw', 'NativeMessagingHosts', 'org.openhorizonlabs.browser_recipes_agent.json'));
  const launcher = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.deepEqual(launcher.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.deepEqual(await nativeRequest(launcher.path, env, extensionId, { command: 'status' }),
    { result: { connected: false, email: null } });
  const plan = await nativeRequest(launcher.path, env, extensionId, { command: 'plan', args: { model: 'demo', prompt: 'demo' } });
  assert.equal(plan.error.code, 'SIGN_IN_REQUIRED');
  const large = await nativeRequest(launcher.path, env, extensionId, { command: 'status', args: { padding: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(large.result.connected, false);
});

test('callback binds the state and returning issued client', () => {
  const uri = (query, path = '/auth/callback') => new URL('http://127.0.0.1:1' + path + '?' + query);
  assert.equal(callbackValues(uri('state=other&code=123&client_id=' + CLIENT), 'secret'), null);
  assert.equal(callbackValues(uri('state=secret&state=secret'), 'secret'), null);
  assert.equal(callbackValues(uri('state=secret', '/other'), 'secret'), null);
  assert.throws(() => callbackValues(uri('state=secret&error=access_denied'), 'secret'), { code: 'SIGN_IN_DECLINED' });
  assert.throws(() => callbackValues(uri('state=secret&code=123'), 'secret'), { code: 'CALLBACK_FAILED' });
  assert.throws(() => callbackValues(uri('state=secret&code=123&client_id=oaiapp_other'), 'secret', CLIENT), { code: 'CALLBACK_FAILED' });
  assert.deepEqual(callbackValues(uri('state=secret&code=123'), 'secret', CLIENT), { code: '123', clientId: CLIENT });
});

function mockOAuth(options = {}) {
  let authorize;
  return {
    async openBrowser(url) {
      authorize = new URL(url);
      assert.equal(authorize.origin, AUTH);
      assert.equal(authorize.searchParams.get('agent_name_hint'), options.returning ? null : 'Browser Recipes');
      assert.equal(authorize.searchParams.get('client_id'), options.returning ? CLIENT : 'dynamic_agent_client');
      assert.match(authorize.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
      const callback = new URL(authorize.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      assert.equal(callback.pathname, '/auth/callback');
      callback.search = new URLSearchParams({
        code: 'mock-code',
        state: authorize.searchParams.get('state'),
        ...(options.returning ? {} : { client_id: CLIENT }),
      });
      assert.equal((await fetch(callback)).status, 200);
    },
    async oauthMetadata() { return ISSUER; },
    async jsonRequest(url, request) {
      if (url === JWKS) return { keys: [key] };
      assert.equal(url, AUTH + '/api/accounts/oauth/token');
      assert.equal(request.method, 'POST');
      assert.equal(request.body.get('client_id'), CLIENT);
      assert.equal(request.body.get('code'), 'mock-code');
      assert.equal(request.body.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'),
        authorize.searchParams.get('code_challenge'));
      return {
        id_token: identity({
          iss: AUTH,
          aud: CLIENT,
          sub: options.subject ?? 'mock-subject',
          email: 'demo@example.test',
          nonce: options.nonce ?? authorize.searchParams.get('nonce'),
          exp: Date.now() / 1000 + 60,
        }),
        access_token: 'mock-access', refresh_token: 'mock-refresh', token_type: 'Bearer', expires_in: 3600,
        scope: options.scope ?? authorize.searchParams.get('scope'),
      };
    },
  };
}

test('dynamic sign-in validates identity and stores only private session files', async t => {
  const root = temporary(t);
  const path = join(root, 'session.json');
  assert.deepEqual(await signIn(root, {}, mockOAuth()), { connected: true, email: 'demo@example.test' });
  const before = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(before.clientId, CLIENT);
  assert.equal(before.refreshToken, 'mock-refresh');
  await assert.rejects(signIn(root, before, mockOAuth({ returning: true, subject: 'different' })), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(signIn(root, before, mockOAuth({ returning: true, nonce: 'invalid' })), { code: 'INVALID_IDENTITY' });
  await assert.rejects(signIn(root, before, mockOAuth({ returning: true, scope: 'openid' })), { code: 'PLAN_NOT_ENABLED' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), before);
});

async function* events(...parts) {
  for (const part of parts) yield Buffer.from(part);
}

test('only a completed inference returns the accumulated plan text', async () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"Sample"}\r\n\r\n';
  const completed = 'data: {"type":"response.completed"}\n\n';
  assert.deepEqual(await readResponse(events(delta.slice(0, 10), delta.slice(10) + completed)), { text: 'Sample' });
  await assert.rejects(readResponse(events(delta)), { code: 'INCOMPLETE_RESPONSE' });
  const limit = 'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n';
  await assert.rejects(readResponse(events(delta, limit)), { code: 'USAGE_LIMIT' });
  const unavailable = limit.replace('usage_limit_exceeded', 'usage_unavailable');
  await assert.rejects(readResponse(events(delta, unavailable)), { code: 'PROVIDER_UNAVAILABLE' });
  const forbidden = limit.replace('usage_limit_exceeded', 'user_not_eligible');
  await assert.rejects(readResponse(events(delta, forbidden)), { code: 'PROVIDER_FORBIDDEN' });
  const incomplete = 'data: ' + 'x'.repeat(512 * 1024) + '\n';
  await assert.rejects(readResponse(events(incomplete, incomplete)), { code: 'RESPONSE_TOO_LARGE' });
});

test('refresh replaces rotating credentials and sign-out clears tokens', async t => {
  const root = temporary(t);
  const file = join(root, 'session.json');
  await signIn(root, {}, mockOAuth());
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const access = await accessToken(root, { ...before, expiresAt: 0 }, async (url, request) => {
    assert.equal(url, AUTH + '/api/accounts/oauth/token');
    assert.equal(request.body.get('grant_type'), 'refresh_token');
    assert.equal(request.body.get('refresh_token'), 'mock-refresh');
    return { access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'Bearer', expires_in: 3600 };
  });
  assert.equal(access, 'fresh-access');
  const rotated = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rotated.refreshToken, 'fresh-refresh');
  assert.equal(rotated.scope, before.scope);
  const revocationEndpoint = AUTH + '/api/accounts/oauth/revoke';
  const signedOut = await signOut(root, rotated, {
    async oauthMetadata() { return { revocation_endpoint: revocationEndpoint }; },
    async request(url, request) {
      assert.equal(url, revocationEndpoint);
      assert.equal(request.body.get('token'), 'fresh-refresh');
      return { status: 200 };
    },
  });
  assert.deepEqual(signedOut, { connected: false, email: 'demo@example.test', revoked: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    hostId: before.hostId, clientId: CLIENT, subject: before.subject, email: before.email,
  });
});

test('the reviewed PDF and image become inline content for the ChatGPT plan', async () => {
  const pdf = Buffer.from('%PDF-1.4\nfixture').toString('base64');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const attachments = [
    { name: 'invoice.pdf', mimeType: 'application/pdf', base64: pdf },
    { name: 'photo.png', mimeType: 'application/octet-stream', base64: png },
  ];
  const args = { prompt: 'Extract fields', model: 'vision-fixture', attachments };
  await plan('mock-token', args, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(options.body);
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.input[0].content, [
      { type: 'input_text', text: args.prompt },
      { type: 'input_file', filename: 'invoice.pdf', file_data: 'data:application/pdf;base64,' + pdf },
      { type: 'input_image', image_url: 'data:image/png;base64,' + png },
    ]);
    return { ok: true, body: events('data: {"type":"response.completed"}\n\n') };
  });
  const invalid = { ...args, attachments: [{ name: 'wrong.pdf', mimeType: 'application/pdf', base64: png }] };
  const unusedProvider = () => assert.fail('Invalid attachments cannot be sent');
  await assert.rejects(plan('mock-token', invalid, unusedProvider), { code: 'INVALID_ATTACHMENT' });
});

test('terminal refresh clears tokens while preserving registration and temporary failures preserve credentials', async t => {
  const root = temporary(t);
  const file = join(root, 'session.json');
  await signIn(root, {}, mockOAuth());
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const expired = { ...before, expiresAt: 0 };
  const exchange = (status, error) => (url, options, profile) => jsonRequest(url, options, profile, async () =>
    Response.json({ error }, { status }));
  await assert.rejects(accessToken(root, expired, exchange(503, 'unavailable')), { code: 'PROVIDER_UNAVAILABLE' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before);
  await assert.rejects(accessToken(root, expired, exchange(400, 'invalid_client')), { code: 'OAUTH_CLIENT_INVALID' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before);
  await assert.rejects(accessToken(root, expired, exchange(400, 'invalid_grant')), { code: 'SESSION_EXPIRED' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    hostId: before.hostId, clientId: CLIENT, subject: before.subject, email: before.email,
  });
});
