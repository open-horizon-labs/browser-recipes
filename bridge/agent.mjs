import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { endianness, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'org.openhorizonlabs.browser_recipes_agent';
const AUTH = 'https://auth.openai.com';
const TOKEN = AUTH + '/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE;
const CALLBACK = '/auth/callback';
const MAX_FRAME = 1024 * 1024;
const REQUEST_TIMEOUT = 35_000;

class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new AgentError(code, message);
}

const nonempty = value => typeof value === 'string' && value.length > 0;
const configRoot = () => process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

function privateRoot() {
  const path = join(configRoot(), 'browser-recipes-agent');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  requireCondition(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077),
    'LOCAL_STORAGE', 'The agent directory must be private and owned by the current user.');
  return path;
}

function readState(root) {
  const path = join(root, 'session.json');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    requireCondition(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077) && info.size < MAX_FRAME,
      'LOCAL_STORAGE', 'The agent session file must be private and owned by the current user.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writePrivate(path, value, mode = 0o600) {
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value), { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function status(session) {
  return {
    connected: nonempty(session.refreshToken) && (session.scope ?? '').split(/\s+/).includes(PLAN_SCOPE),
    email: session.email ?? null,
  };
}

function safeEndpoint(value, expected) {
  requireCondition(value === expected, 'PROVIDER_PROTOCOL', 'OpenAI returned an unexpected configuration.');
  return value;
}

function responseError(status, profile = false) {
  if (status === 401 || status === 403 || (profile && status === 400)) {
    return new AgentError('SIGN_IN_REQUIRED', 'Continue with ChatGPT to renew access.');
  }
  if (status === 429) return new AgentError('USAGE_LIMIT', 'OpenAI rate or plan usage limit reached. Check ChatGPT Settings.');
  return new AgentError('PROVIDER_ERROR', 'OpenAI could not complete the request.');
}

async function request(url, options = {}) {
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
  } catch {
    throw new AgentError('PROVIDER_UNAVAILABLE', 'Could not reach OpenAI. Try again.');
  }
}

async function jsonRequest(url, options = {}, profile = false) {
  const response = await request(url, options);
  if (!response.ok) throw responseError(response.status, profile);
  return response.json();
}

const formPost = fields => ({ method: 'POST', body: new URLSearchParams(fields) });
const oauthMetadata = () => jsonRequest(AUTH + '/.well-known/openid-configuration');

export async function verifyIdentity(jwt, clientId, nonce, metadata, loadKeys) {
  requireCondition(typeof jwt === 'string' && jwt.length < 32768, 'INVALID_IDENTITY', 'OpenAI returned an invalid identity token.');
  const fields = jwt.split('.');
  requireCondition(fields.length === 3 && fields.every(field => /^[\w-]+$/.test(field)),
    'INVALID_IDENTITY', 'OpenAI returned an invalid identity token.');
  const decode = field => JSON.parse(Buffer.from(field, 'base64url').toString('utf8'));
  const [header, claims] = fields.slice(0, 2).map(decode);
  requireCondition(header.alg === 'RS256' && nonempty(header.kid), 'INVALID_IDENTITY', 'Unexpected identity signing algorithm.');
  const jwks = await loadKeys(safeEndpoint(metadata.jwks_uri, AUTH + '/.well-known/jwks.json'));
  const keys = jwks.keys.filter(key => key.kid === header.kid && key.kty === 'RSA');
  requireCondition(keys.length === 1, 'INVALID_IDENTITY', 'The OpenAI identity signing key was unavailable.');
  const verified = verify('RSA-SHA256', Buffer.from(fields.slice(0, 2).join('.')),
    createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(fields[2], 'base64url'));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  requireCondition(verified && metadata.issuer === AUTH && claims.iss === AUTH && audiences.includes(clientId) &&
    (audiences.length === 1 || claims.azp === clientId) &&
    (claims.azp === undefined || claims.azp === clientId) &&
    Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000 &&
    claims.nonce === nonce && nonempty(claims.sub),
  'INVALID_IDENTITY', 'OpenAI identity validation failed.');
  return { subject: claims.sub, email: nonempty(claims.email) ? claims.email : null };
}

function secureCompare(first, second) {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function callbackValues(url, state, previousClient) {
  const params = url.searchParams;
  const one = name => params.getAll(name).length === 1 ? params.get(name) : null;
  if (url.pathname !== CALLBACK || !secureCompare(one('state') ?? '', state)) return null;
  requireCondition(!params.has('error'), 'SIGN_IN_DECLINED', 'ChatGPT sign-in or plan consent was declined.');
  const code = one('code');
  const newClient = one('client_id');
  const clientId = previousClient ?? newClient;
  requireCondition(nonempty(code) && /^oaiapp_[A-Za-z0-9_-]+$/.test(clientId ?? '') &&
    (!previousClient || !params.has('client_id') || newClient === previousClient),
  'CALLBACK_FAILED', 'ChatGPT sign-in returned an incomplete or mismatched registration.');
  return { code, clientId };
}

function authCallback(state, previousClient) {
  let finish;
  let reject;
  const credentials = new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
  credentials.catch(() => {}); // The browser can abort before the caller begins awaiting.
  const server = createServer((req, res) => {
    const reply = (code, text) => res.writeHead(code, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Connection': 'close',
    }).end(text);
    try {
      const result = req.method === 'GET' && req.headers.host === '127.0.0.1:' + server.address().port &&
        callbackValues(new URL(req.url, 'http://127.0.0.1'), state, previousClient);
      if (!result) return reply(404, 'This request does not match a Browser Recipes sign-in.');
      reply(200, 'ChatGPT returned to Browser Recipes. You can close this tab and check Browser Recipes for the result.');
      finish(result);
    } catch (error) {
      reply(400, 'ChatGPT sign-in did not complete. Return to Browser Recipes.');
      reject(error);
    }
  });
  const ready = new Promise((resolve, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port + CALLBACK));
  });
  const timer = setTimeout(() => reject(new AgentError('SIGN_IN_TIMEOUT', 'ChatGPT sign-in timed out. Try again.')), 180_000);
  return { ready, credentials, close() { clearTimeout(timer); server.close(); server.closeAllConnections(); } };
}

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('xdg-open', [url], { stdio: 'ignore' });
    const failed = () => reject(new AgentError('BROWSER_UNAVAILABLE', 'Could not open the system browser for ChatGPT sign-in.'));
    child.once('error', failed);
    child.once('exit', code => { if (code === 0) resolve(); else failed(); });
  });
}

function tokenSession(session, tokens) {
  const scope = tokens.scope ?? session.scope;
  requireCondition(typeof scope === 'string' && scope.split(/\s+/).includes(PLAN_SCOPE), 'PLAN_NOT_ENABLED',
    'ChatGPT plan usage is disabled for this connection. Enable it in ChatGPT and sign in again.');
  requireCondition(nonempty(tokens.access_token) && nonempty(tokens.refresh_token) &&
    typeof tokens.token_type === 'string' && tokens.token_type.toLowerCase() === 'bearer' &&
    Number.isFinite(tokens.expires_in) && tokens.expires_in > 0, 'INVALID_SESSION', 'OpenAI returned an incomplete session.');
  return {
    ...session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, scope,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

export async function signIn(root, previous, dependencies = { openBrowser, jsonRequest, oauthMetadata }) {
  const path = join(root, 'session.json');
  const hostId = previous.hostId ?? 'urn:uuid:' + randomUUID();
  if (!previous.hostId) writePrivate(path, { ...previous, hostId });
  const previousClient = previous.clientId;
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const callback = authCallback(state, previousClient);
  try {
    const redirect = await callback.ready;
    const authorize = new URL(AUTH + '/api/accounts/authorize');
    authorize.search = new URLSearchParams({
      client_id: previousClient ?? DYNAMIC_CLIENT,
      ...(previousClient ? {} : { agent_name_hint: 'Browser Recipes' }),
      ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope: SCOPES,
      resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const [, { code, clientId }] = await Promise.all([dependencies.openBrowser(authorize.href), callback.credentials]);
    const tokens = await dependencies.jsonRequest(TOKEN, formPost({
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
      resource: RESOURCE, redirect_uri: redirect,
    }), true);
    const metadata = await dependencies.oauthMetadata();
    const identity = await verifyIdentity(tokens.id_token, clientId, nonce, metadata, dependencies.jsonRequest);
    requireCondition(!previousClient || previous.subject === identity.subject,
      'ACCOUNT_CHANGED', 'The returned ChatGPT account does not match the saved account.');
    const session = tokenSession({ ...identity, hostId, clientId, idToken: tokens.id_token }, tokens);
    writePrivate(path, session);
    return status(session);
  } finally {
    callback.close();
  }
}

export async function signOut(root, session, dependencies = { oauthMetadata, request }) {
  let revoked = !session.refreshToken;
  if (session.refreshToken) {
    for (const delay of [0, 350, 950]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const metadata = await dependencies.oauthMetadata();
        const endpoint = safeEndpoint(metadata.revocation_endpoint, AUTH + '/api/accounts/oauth/revoke');
        const response = await dependencies.request(endpoint, formPost({
          token: session.refreshToken, token_type_hint: 'refresh_token', client_id: session.clientId,
        }));
        revoked = response.status === 200;
        if (response.status < 500) break;
      } catch (error) {
        if (!['PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR'].includes(error.code)) break;
      }
    }
  }
  const { hostId, clientId, subject, email } = session;
  const cleared = { hostId, clientId, subject, email };
  writePrivate(join(root, 'session.json'), cleared);
  return { ...status(cleared), revoked };
}

export async function accessToken(root, session, exchange = jsonRequest) {
  requireCondition(status(session).connected, 'SIGN_IN_REQUIRED', 'Continue with ChatGPT to enable planning.');
  if (session.expiresAt > Date.now() + 60_000) return session.accessToken;
  const tokens = await exchange(TOKEN, formPost({
    grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource: RESOURCE,
  }), true);
  const refreshed = tokenSession(session, tokens);
  writePrivate(join(root, 'session.json'), refreshed);
  return refreshed.accessToken;
}

async function models(token) {
  const response = await jsonRequest(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + token } });
  requireCondition(Array.isArray(response.models), 'PROVIDER_PROTOCOL', 'OpenAI returned an unexpected model list.');
  return { models: response.models.filter(item => item.visibility === 'list' && nonempty(item.slug) && nonempty(item.display_name))
    .map(item => ({ id: item.slug, name: item.display_name })) };
}

export async function readResponse(stream) {
  const decoder = new TextDecoder();
  let pending = '';
  let output = '';
  let eventData = [];
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    requireCondition(pending.length < MAX_FRAME, 'RESPONSE_TOO_LARGE', 'The model response was too large.');
    let next;
    while ((next = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, next).replace(/\r$/, '');
      pending = pending.slice(next + 1);
      if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
      if (line !== '' || eventData.length === 0) continue;
      const data = eventData.join('\n');
      eventData = [];
      if (data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') output += event.delta;
      requireCondition(output.length <= 50_000, 'RESPONSE_TOO_LARGE', 'The model response was too large.');
      if (event.type === 'response.completed') return { text: output };
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        const code = event.response?.error?.code ?? event.code;
        if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable') {
          throw new AgentError('USAGE_LIMIT', 'ChatGPT plan usage is unavailable or its limit was reached. Check ChatGPT Settings.');
        }
        throw new AgentError('INCOMPLETE_RESPONSE', 'The model did not complete the plan.');
      }
    }
  }
  throw new AgentError('INCOMPLETE_RESPONSE', 'The model stream ended before the plan completed.');
}

async function plan(token, { prompt, model }) {
  requireCondition(typeof prompt === 'string' && nonempty(prompt.trim()) && prompt.length <= 50_000 &&
    typeof model === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(model), 'INVALID_REQUEST', 'Provide a prompt and select a model.');
  const response = await request(RESOURCE + '/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: prompt }], store: false, stream: true }),
  });
  if (!response.ok) throw responseError(response.status);
  return readResponse(response.body);
}

async function dispatch({ command, args = {} }, root) {
  requireCondition(args !== null && typeof args === 'object' && !Array.isArray(args), 'INVALID_REQUEST', 'Expected agent arguments.');
  const session = readState(root);
  if (command === 'status') return status(session);
  if (command === 'signin') return signIn(root, session);
  if (command === 'signout') return signOut(root, session);
  if (command === 'models') return models(await accessToken(root, session));
  if (command === 'plan') return plan(await accessToken(root, session), args);
  throw new AgentError('UNKNOWN_COMMAND', 'Unknown Browser Recipes agent command.');
}

const readLength = endianness() === 'LE' ? 'readUInt32LE' : 'readUInt32BE';
const writeLength = endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE';

async function nativeRequest() {
  let frame = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    frame = Buffer.concat([frame, chunk]);
    if (frame.length < 4) continue;
    const size = frame[readLength]();
    requireCondition(size > 0 && size <= MAX_FRAME, 'INVALID_REQUEST', 'Invalid agent message size.');
    if (frame.length >= size + 4) return JSON.parse(frame.subarray(4, size + 4));
  }
  throw new AgentError('INVALID_REQUEST', 'Incomplete agent request.');
}

function nativeReply(reply) {
  let body = Buffer.from(JSON.stringify(reply));
  if (body.length > MAX_FRAME) {
    body = Buffer.from(JSON.stringify({error:{ code:'RESPONSE_TOO_LARGE', message:'The agent response was too large.' }}));
  }
  const header = Buffer.alloc(4);
  header[writeLength](body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function asError(error) {
  return error instanceof AgentError ? { code: error.code, message: error.message } :
    { code: 'AGENT_ERROR', message: 'Browser Recipes could not complete the agent request.' };
}

async function runLocked(request, root) {
  const path = join(root, 'session.lock');
  // flock holds the lock for the entire child process, including OAuth refresh and atomic credential replacement.
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-F', '-n', '-E', '75', path, process.execPath, fileURLToPath(import.meta.url), '--worker'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', () => {}); // A competing request can exit before reading stdin.
    child.stdin.end(JSON.stringify(request));
    const abort = () => {
      child.kill('SIGTERM');
      process.exit(1);
    };
    process.once('SIGTERM', abort);
    child.once('error', reject);
    child.once('close', code => {
      process.removeListener('SIGTERM', abort);
      if (code === 75) return reject(new AgentError('BUSY', 'Another agent request is in progress.'));
      if (code !== 0) return reject(new AgentError('LOCAL_AGENT', 'Could not start the local agent worker. Check that flock is installed.'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
    });
  });
}

function install(extensionId, args = []) {
  requireCondition(/^[a-p]{32}$/.test(extensionId ?? ''), 'INSTALL_FAILED', 'Use the 32-character extension ID from the browser Extensions page.');
  const browser = args.length === 0 ? 'chrome' : args[0] === '--browser' && args.length === 2 ? args[1] : undefined;
  const directories = { chrome: 'google-chrome', chromium: 'chromium', 'browseros-neo': 'browser-claw' };
  requireCondition(Object.hasOwn(directories, browser), 'INSTALL_FAILED', 'Choose chrome, chromium, or browseros-neo with --browser.');
  const directory = join(configRoot(), directories[browser], 'NativeMessagingHosts');
  mkdirSync(directory, { recursive: true });
  const launcher = join(privateRoot(), 'native-host');
  const nodePath = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
  const entry = "'" + fileURLToPath(import.meta.url).replaceAll("'", "'\\''") + "'";
  writePrivate(launcher, '#!/bin/sh\nexec ' + nodePath + ' ' + entry + ' "$@"\n', 0o700);
  const path = join(directory, HOST + '.json');
  writePrivate(path, {
    name: HOST, description: 'Local Browser Recipes ChatGPT agent',
    path: launcher, type: 'stdio', allowed_origins: ['chrome-extension://' + extensionId + '/'],
  });
  return path;
}

export async function main([command, ...args]) {
  if (command === 'install') {
    try { process.stdout.write(install(args[0], args.slice(1)) + '\n'); }
    catch (error) { process.stderr.write(asError(error).message + '\n'); process.exitCode = 1; }
    return;
  }
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(command ?? '')) {
    process.stderr.write('Usage: browser-recipes-agent install EXTENSION_ID [--browser chrome|chromium|browseros-neo]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const request = await nativeRequest();
    const root = privateRoot();
    const reply = request.command === 'status'
      ? { result: await dispatch(request, root) }
      : await runLocked(request, root);
    nativeReply(reply);
  } catch (error) {
    nativeReply({ error: asError(error) });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--worker') {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString()), privateRoot());
      process.stdout.write(JSON.stringify({ result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: asError(error) }));
    }
  } else {
    await main(process.argv.slice(2));
  }
}
