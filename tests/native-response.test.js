import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { endianness } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nativeResponseFrames } from '../extension/native-response.js';

const bridge = fileURLToPath(new URL('../bridge/browser-recipes', import.meta.url));
const id = 'native-response-test';
const maxFrameBytes = 1024 * 1024;
const decodeInCli = [
  'import base64, hashlib, runpy, sys',
  'bridge = runpy.run_path(sys.argv[1])',
  'response = bridge["read_response"](sys.stdin.buffer, sys.argv[2])',
  'result = response["result"]',
  'print(result["name"])',
  'print(hashlib.sha256(base64.b64decode(result["base64"], validate=True)).hexdigest())',
].join('\n');

function toWire(frame) {
  const body = Buffer.from(JSON.stringify(frame));
  assert.ok(body.length < maxFrameBytes);
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function cliDecode(frames) {
  return spawnSync('python3', ['-c', decodeInCli, bridge, id], {
    input: Buffer.concat(frames.map(toWire)),
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('transfers an 8 MiB binary result through extension frames to the CLI', () => {
  const file = Buffer.alloc(8 * 1024 * 1024);
  for (let index = 0; index < file.length; index++) file[index] = index % 251;
  const result = { kind: 'file', name: '扫描☃.png', mimeType: 'image/png', base64: file.toString('base64') };
  const frames = [...nativeResponseFrames({ id, result })];
  assert.ok(frames.length > 1);
  const decoded = cliDecode(frames);
  assert.equal(decoded.status, 0, decoded.stderr);
  assert.equal(decoded.stdout.trim(), result.name + '\n' + createHash('sha256').update(file).digest('hex'));
});

test('returns small responses directly and caps aggregate response bytes', () => {
  const response = { id, result: { value: 'text ☃' } };
  assert.deepEqual([...nativeResponseFrames(response)], [response]);
  const tooLarge = { id, result: 'x'.repeat(12 * 1024 * 1024) };
  assert.equal([...nativeResponseFrames(tooLarge)][0].error.code, 'OUTPUT_TOO_LARGE');
});

test('CLI rejects a missing chunk or an unbounded declared total', () => {
  const response = { id, result: { name: 'scan.png', base64: Buffer.alloc(1024 * 1024).toString('base64') } };
  const frames = [...nativeResponseFrames(response)];
  assert.ok(frames.length > 2);
  assert.match(cliDecode([frames[0], frames[2]]).stderr, /Invalid response chunk/);
  const bad = { id, chunk: { ...frames[0].chunk, total: 10_000 } };
  assert.match(cliDecode([bad]).stderr, /Invalid response chunk/);
});
