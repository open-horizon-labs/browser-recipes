import { constants } from 'node:fs';
import { mkdir, open, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeResponseFrames } from '../extension/native-response.js';

export const host = 'org.openhorizonlabs.browser_recipes_source_servicenow';
const MAX_FILE = 8 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const apiName = /^[a-z][a-z0-9_]{0,79}$/i;
const sourceName = /^[a-z][a-z0-9-]{0,63}$/;
const recordId = /^[0-9a-f]{32}$/;
const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { safe: true });

async function privateText(path, maximum) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maximum) throw new Error();
    const buffer = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (!offset || offset > maximum) throw new Error();
    return buffer.toString('utf8', 0, offset);
  } catch {
    throw invalid('Set up the private ServiceNow configuration and credential files with permissions 0600.');
  } finally {
    await handle?.close();
  }
}

export function validateServiceNowConfig(config) {
  let url;
  try { url = new URL(config?.origin); } catch {}
  if (!url || url.protocol !== 'https:' || url.origin !== config.origin || url.username || url.password || !object(config.sources)) {
    throw invalid('Configure a single exact HTTPS ServiceNow instance and its allowed sources.');
  }
  const { auth } = config;
  if (!object(auth) || !['basic', 'bearer'].includes(auth.type) || typeof auth.file !== 'string' || !isAbsolute(auth.file) ||
      (auth.type === 'basic' && (typeof auth.username !== 'string' || !/^[^\s:\x00-\x1f]{1,128}$/.test(auth.username)))) {
    throw invalid('Configure a local Basic or Bearer credential file.');
  }
  const entries = Object.entries(config.sources);
  if (entries.length < 1 || entries.length > 16) throw invalid('Configure one to sixteen allowed sources.');
  for (const [name, source] of entries) {
    if (!sourceName.test(name) || !object(source) || typeof source.table !== 'string' || !apiName.test(source.table) ||
        !Array.isArray(source.fields) || source.fields.length < 1 || source.fields.length > 20 ||
        source.fields.some(field => typeof field !== 'string' || !apiName.test(field) || ['constructor', 'prototype'].includes(field)) ||
        !source.fields.includes(source.label) || (source.limit !== undefined &&
          (!Number.isInteger(source.limit) || source.limit < 1 || source.limit > 100))) {
      throw invalid('Check the configured ServiceNow source table, output fields, label, and limit.');
    }
    if (source.filter !== undefined && (!object(source.filter) || Object.keys(source.filter).length > 12 ||
        Object.entries(source.filter).some(([key, value]) => !apiName.test(key) || typeof value !== 'string' ||
          !/^[a-z0-9_.@ -]{1,80}$/i.test(value)))) {
      throw invalid('Use simple fixed ServiceNow filter field values.');
    }
  }
  return config;
}

async function loadConfig() {
  const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'browser-recipes', 'servicenow.json');
  let parsed;
  try { parsed = JSON.parse(await privateText(path, 16_384)); }
  catch (error) {
    if (error.safe) throw error;
    throw invalid('The private ServiceNow configuration must be valid JSON.');
  }
  const config = validateServiceNowConfig(parsed);
  const secret = (await privateText(config.auth.file, 4096)).replace(/\r?\n$/, '');
  if (!secret || /[\x00-\x1f\x7f]/.test(secret)) throw invalid('The ServiceNow credential file is invalid.');
  const authorization = config.auth.type === 'basic'
    ? 'Basic ' + Buffer.from(config.auth.username + ':' + secret).toString('base64')
    : 'Bearer ' + secret;
  return { config, authorization };
}

async function readBounded(response, maximum) {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) throw invalid('The ServiceNow response exceeds the size limit.');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw invalid('The ServiceNow response exceeds the size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}

function fieldsFor(row, allowed) {
  return Object.fromEntries(allowed.flatMap(key => {
    if (!own(row, key)) return [];
    const value = object(row[key]) ? row[key].value : row[key];
    return ['number', 'string', 'boolean'].includes(typeof value) ? [[key, String(value).slice(0, 512)]] : [];
  }));
}

function metadata(row, source, record) {
  if (!object(row) || typeof row.sys_id !== 'string' || !recordId.test(row.sys_id) || row.table_name !== source.table ||
      row.table_sys_id !== record || typeof row.file_name !== 'string' || !row.file_name.trim()) return null;
  const name = row.file_name.replace(/[\/\\\x00-\x1f\x7f]/g, '_').slice(0, 180);
  const bytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  const type = typeof row.content_type === 'string' ? row.content_type.toLowerCase().split(';')[0].trim() : '';
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream';
  return { id: row.sys_id, name, mimeType, bytes, available: bytes <= MAX_FILE };
}

export function createServiceNowConnector(config, authorization, fetcher = fetch) {
  validateServiceNowConfig(config);
  function target(path, query = {}) {
    const url = new URL(path, config.origin);
    url.search = new URLSearchParams(query);
    return url;
  }
  async function get(path, query, maximum, accept) {
    const url = target(path, query);
    let response;
    try {
      response = await fetcher(url, {
        method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { authorization, accept }, signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw invalid('The configured ServiceNow request failed or redirected.');
    }
    if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== config.origin)) {
      throw invalid('The configured ServiceNow request was denied, redirected, or unavailable.');
    }
    return { body: await readBounded(response, maximum), type: response.headers.get('content-type') ?? '' };
  }
  async function json(path, query) {
    const { body } = await get(path, query, MAX_JSON, 'application/json');
    try { return JSON.parse(body.toString('utf8')).result; }
    catch { throw invalid('The configured ServiceNow API did not return the expected JSON.'); }
  }
  async function records(source, record) {
    const clauses = Object.entries(source.filter ?? {}).map(([key, value]) => key + '=' + value);
    if (record) clauses.unshift('sys_id=' + record);
    const limit = record ? 1 : source.limit ?? 30;
    const rows = await json('/api/now/table/' + source.table, {
      sysparm_fields: [...new Set(['sys_id', ...source.fields])].join(','),
      sysparm_query: clauses.join('^'), sysparm_limit: String(limit), sysparm_exclude_reference_link: 'true',
      sysparm_display_value: 'false',
    });
    if (!Array.isArray(rows) || rows.length > limit) throw invalid('The ServiceNow record list did not match the configured bounds.');
    return { records: rows.flatMap(row => {
      if (typeof row?.sys_id !== 'string' || !recordId.test(row.sys_id) || (record && row.sys_id !== record)) return [];
      const fields = fieldsFor(row, source.fields);
      return [{ id: row.sys_id, label: fields[source.label] || row.sys_id, fields }];
    }), limited: !record && rows.length === limit };
  }

  return async (operation, args) => {
    const keys = { records: ['source'], attachments: ['source', 'record'], document: ['source', 'record', 'attachment'] };
    if (!own(keys, operation) || !object(args) || Object.keys(args).some(key => !keys[operation].includes(key)) ||
        typeof args.source !== 'string' || !own(config.sources, args.source) ||
        (operation !== 'records' && (typeof args.record !== 'string' || !recordId.test(args.record))) ||
        (operation === 'document' && (typeof args.attachment !== 'string' || !recordId.test(args.attachment)))) {
      throw invalid('Choose a configured ServiceNow source and valid record or attachment identifiers.');
    }
    const source = config.sources[args.source];
    if (operation === 'records') return records(source);
    if (!(await records(source, args.record)).records.length) throw invalid('The selected record is outside the configured ServiceNow source.');
    if (operation === 'attachments') {
      const rows = await json('/api/now/attachment', {
        sysparm_query: 'table_name=' + source.table + '^table_sys_id=' + args.record, sysparm_limit: '50',
      });
      if (!Array.isArray(rows) || rows.length > 50) throw invalid('The ServiceNow attachment list did not match the configured bounds.');
      const attachments = rows.map(row => metadata(row, source, args.record)).filter(Boolean);
      return { attachments, limited: rows.length === 50 };
    }
    const path = '/api/now/attachment/' + args.attachment;
    const file = metadata(await json(path, {}), source, args.record);
    if (!file?.available || file.id !== args.attachment) throw invalid('The selected attachment is outside the configured record or exceeds 8 MiB.');
    const { body, type } = await get(path + '/file', {}, MAX_FILE, 'application/octet-stream');
    if (body.length !== file.bytes || /^text\/html\b/i.test(type)) throw invalid('The ServiceNow download did not match its attachment metadata.');
    return { document: { kind: 'file', name: file.name, mimeType: file.mimeType, base64: body.toString('base64') } };
  };
}

async function readMessage(stream) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of stream) {
    if (bytes.length + chunk.length > 65_540) throw invalid('The source request is too large.');
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) continue;
    const size = bytes.readUInt32LE(0);
    if (!size || size > 65_536) throw invalid('The source request is invalid.');
    if (bytes.length >= size + 4) return JSON.parse(bytes.subarray(4, size + 4).toString('utf8'));
  }
  throw invalid('The source request was incomplete.');
}

export async function runServiceNowHost(stdin, stdout) {
  let id = 'unknown';
  let response;
  try {
    const message = await readMessage(stdin);
    if (typeof message?.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(message.id)) throw invalid('The source request is invalid.');
    id = message.id;
    const { config, authorization } = await loadConfig();
    const result = await createServiceNowConnector(config, authorization)(message.operation, message.args);
    response = { id, result };
  } catch (error) {
    response = { id, error: { code: 'SOURCE_FAILED', message: error.safe ? error.message : 'The ServiceNow source request failed.' } };
  }
  for (const frame of nativeResponseFrames(response)) {
    const bytes = Buffer.from(JSON.stringify(frame));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    await new Promise((resolve, reject) => {
      stdout.write(Buffer.concat([header, bytes]), error => error ? reject(error) : resolve());
    });
  }
}

const hostDirs = {
  chrome: '.config/google-chrome/NativeMessagingHosts',
  chromium: '.config/chromium/NativeMessagingHosts',
  'browseros-neo': '.config/browser-claw/NativeMessagingHosts',
};

export async function installServiceNowHost(id, browser = 'chrome') {
  if (!/^[a-p]{32}$/.test(id) || !own(hostDirs, browser)) throw invalid('Use the extension ID and a supported Linux browser.');
  const directory = join(homedir(), hostDirs[browser]);
  const target = join(directory, host + '.json');
  const temporary = target + '.' + process.pid;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({
      name: host, description: 'Browser Recipes read-only ServiceNow source',
      path: fileURLToPath(new URL('./browser-recipes-servicenow', import.meta.url)),
      type: 'stdio', allowed_origins: ['chrome-extension://' + id + '/'],
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
