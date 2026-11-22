import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asError, dispatch, privateRoot } from './agent.mjs';

export const companionPort = 18789;
const host = '127.0.0.1';
const route = '/v1/agent';
const commandSet = new Set(['status', 'signin', 'signout', 'models', 'plan']);
const maxBytes = 12 * 1024 * 1024;

function sameToken(header, token) {
  const provided = Buffer.from(header ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

const failure = (code, message) => ({ error: { code, message } });

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

export function createCompanion({ extensionId, token, call }) {
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('Use the 32-character extension ID from the browser Extensions page.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw new Error('Use a 32-byte random pairing code.');
  const allowedOrigin = 'chrome-extension://' + extensionId;
  let busy = false;
  const server = createServer(async (request, response) => {
    const address = server.address();
    if (request.headers.host !== `${host}:${address?.port}` ||
        request.url !== route || request.headers.origin !== allowedOrigin) {
      return send(response, 403, failure('PAIRING_ORIGIN', 'This endpoint is reserved for the paired extension.'));
    }
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] === 'POST') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return response.end();
    }
    if (request.method !== 'POST') return send(response, 405, failure('INVALID_REQUEST', 'Use POST for agent requests.'));
    if (!sameToken(request.headers.authorization, token)) {
      return send(response, 401, failure('PAIRING_REQUIRED', 'The pairing code expired or does not match the running helper.'));
    }
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      return send(response, 415, failure('INVALID_REQUEST', 'Use a JSON request.'));
    }
    if (Number(request.headers['content-length']) > maxBytes) {
      return send(response, 413, failure('REQUEST_TOO_LARGE', 'The request exceeded the local helper size limit.'));
    }
    if (busy) return send(response, 409, failure('BUSY', 'Another local ChatGPT request is in progress.'));
    busy = true;
    try {
      let message;
      try {
        message = await readBody(request);
      } catch {
        return send(response, 400, failure('INVALID_REQUEST', 'Enter a valid agent request.'));
      }
      if (message === null) return send(response, 413, failure('REQUEST_TOO_LARGE', 'The request exceeded the local helper size limit.'));
      if (!commandSet.has(message?.command)) return send(response, 400, failure('INVALID_REQUEST', 'Choose a supported ChatGPT command.'));
      const result = await call(message);
      return send(response, 200, { result });
    } catch (error) {
      return send(response, 200, { error: asError(error) });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return server;
}

function start(extensionId) {
  const token = randomBytes(32).toString('base64url');
  const root = privateRoot('browser-recipes-companion');
  const server = createCompanion({ extensionId, token, call: message => dispatch(message, root) });
  server.once('error', () => {
    process.stderr.write('Could not open the local ChatGPT helper. Close any other instance and try again.\n');
    process.exitCode = 1;
  });
  server.listen(companionPort, host, () => {
    process.stdout.write('Browser Recipes ChatGPT helper is running on this computer.\n' +
      'Enter this pairing code in Browser Recipes Settings. It expires when the helper stops.\n' + token + '\n');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    start(process.argv[2]);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
