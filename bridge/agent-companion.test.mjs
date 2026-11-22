import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createCompanion } from './agent-companion.mjs';

const extensionId = 'a'.repeat(32);
const origin = 'chrome-extension://' + extensionId;
const token = 'b'.repeat(43);

test('the companion authenticates the paired extension before accepting a command', async t => {
  const calls = [];
  const server = createCompanion({
    extensionId, token,
    async call(request) {
      calls.push(request);
      return { connected: false, email: null };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/agent';
  const send = (command, headers = {}, endpoint = url) => fetch(endpoint, {
    method: 'POST',
    headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ command, args: {} }),
  });
  const options = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await send('status', { Origin: 'https://example.test' })).status, 403);
  assert.equal((await send('status', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await send('status', {}, url + '?unexpected')).status, 403);
  assert.equal((await send('shell')).status, 400);
  assert.deepEqual(calls, []);
  const status = await send('status');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { result: { connected: false, email: null } });
  assert.deepEqual(calls, [{ command: 'status', args: {} }]);
});
