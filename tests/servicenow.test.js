import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createServiceNowConnector, validateServiceNowConfig } from '../bridge/servicenow.mjs';
import { assertConnectorSharingAllowed, runConnector } from '../extension/connector.js';
import { nativeResponseFrames } from '../extension/native-response.js';
import { workflowTransforms } from '../extension/workflow-transforms.js';

const id = 'a'.repeat(32), attachmentId = 'b'.repeat(32), other = 'c'.repeat(32);
const config = {
  origin: 'https://example.service-now.test',
  auth: { type: 'bearer', file: '/secret/on/local/host' },
  sources: {
    invoices: { table: 'invoice_tasks', fields: ['number', 'description'], label: 'number', filter: { active: 'true' }, limit: 10 },
  },
};
const secret = 'Bearer synthetic-only';
const invoice = new URL('../examples/document-review/site/files/invoice-text.pdf', import.meta.url);

function fixture(pdf, metadataChanges = {}, options = {}) {
  const requests = [];
  const row = { sys_id: id, number: 'INV-1042', description: { value: 'Invoice available' }, private_field: 'not allowed' };
  const file = {
    sys_id: attachmentId, table_name: 'invoice_tasks', table_sys_id: id, file_name: 'invoice.pdf',
    content_type: 'application/pdf', size_bytes: pdf.length,
    download_link: 'https://untrusted.test/secret',
    ...metadataChanges,
  };
  const read = createServiceNowConnector(config, secret, async (url, request) => {
    requests.push(url);
    assert.equal(url.origin, config.origin);
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, secret);
    if (options.redirect) return Object.defineProperty(Response.json({}), 'redirected', { value: true });
    if (url.pathname === '/api/now/table/invoice_tasks') {
      assert.equal(url.searchParams.get('sysparm_fields'), 'sys_id,number,description');
      const query = url.searchParams.get('sysparm_query');
      assert.ok(query.endsWith('active=true'));
      const selected = query.startsWith('sys_id=');
      return Response.json({ result: selected && options.removed ? [] : [row] });
    }
    if (url.pathname === '/api/now/attachment') {
      assert.equal(url.searchParams.get('sysparm_query'), 'table_name=invoice_tasks^table_sys_id=' + id);
      return Response.json({ result: [file, { ...file, sys_id: other, table_sys_id: other }] });
    }
    if (url.pathname === '/api/now/attachment/' + attachmentId) return Response.json({ result: file });
    assert.equal(url.pathname, '/api/now/attachment/' + attachmentId + '/file');
    return new Response(options.file ?? pdf, { headers: { 'content-type': options.type ?? 'application/pdf' } });
  });
  return { read, requests };
}

test('lists allowlisted fields, selects a record and retrieves the matching PDF', async () => {
  const pdf = await readFile(invoice);
  const { read, requests } = fixture(pdf);
  const { records } = await read('records', { source: 'invoices' });
  assert.deepEqual(records, [{ id, label: 'INV-1042', fields: { number: 'INV-1042', description: 'Invoice available' } }]);
  const { items } = workflowTransforms['select-rows']({ rows: records });
  const record = workflowTransforms['one-selection']({ items: [items[0].value] }).value;
  assert.throws(() => workflowTransforms['one-selection']({ items: [] }), /exactly one/);
  const { attachments } = await read('attachments', { source: 'invoices', record: record.id });
  assert.deepEqual(attachments.map(item => item.id), [attachmentId]);
  const output = await read('document', { source: 'invoices', record: record.id, attachment: attachments[0].id });
  assert.deepEqual(Buffer.from(output.document.base64, 'base64'), pdf);
  assert.equal(requests.at(-1).pathname, '/api/now/attachment/' + attachmentId + '/file');
  assert.ok(requests.every(url => url.hostname === 'example.service-now.test'));
});

test('rejects unconfigured operations, protocol changes, redirects, and attachments on other records', async () => {
  assert.throws(() => validateServiceNowConfig({ ...config, origin: 'http://example.test' }), /exact HTTPS/);
  assert.throws(() => validateServiceNowConfig({ ...config, origin: 'https://example.test/path' }), /exact HTTPS/);
  const pdf = await readFile(invoice);
  const wrong = fixture(pdf, { table_sys_id: other });
  await assert.rejects(wrong.read('document', { source: 'invoices', record: id, attachment: attachmentId }), /outside the configured record/);
  assert.ok(wrong.requests.every(url => !url.pathname.endsWith('/file')));
  await assert.rejects(wrong.read('write', { source: 'invoices' }), /configured ServiceNow source/);
  await assert.rejects(wrong.read('records', { source: 'unregistered' }), /configured ServiceNow source/);
  await assert.rejects(wrong.read('records', { source: 'invoices', query: 'any' }), /configured ServiceNow source/);
  await assert.rejects(fixture(pdf, {}, { removed: true }).read('attachments', { source: 'invoices', record: id }), /outside the configured ServiceNow source/);
  await assert.rejects(fixture(pdf, {}, { redirect: true }).read('records', { source: 'invoices' }), /redirected/);
  await assert.rejects(fixture(pdf, {}, { file: new Uint8Array(9 * 1024 * 1024) })
    .read('document', { source: 'invoices', record: id, attachment: attachmentId }), /size limit/);
  await assert.rejects(fixture(pdf, {}, { type: 'text/html' })
    .read('document', { source: 'invoices', record: id, attachment: attachmentId }), /metadata/);
});

function browserFixture(result, setting) {
  let touched = false;
  const browser = {
    storage: { local: { get: async () => ({ connectors: setting }) } },
    runtime: { connectNative: host => {
      touched = true;
      assert.equal(host, 'org.openhorizonlabs.browser_recipes_source_servicenow');
      let respond;
      return {
        onMessage: { addListener: listener => { respond = listener; } },
        onDisconnect: { addListener: () => {} },
        postMessage: request => queueMicrotask(() => {
          for (const frame of nativeResponseFrames({ id: request.id, result })) respond(frame);
        }),
        disconnect() {},
      };
    } },
  };
  return { browser, get touched() { return touched; } };
}

test('connector is opt-in, blocks model sharing by default, and converts PDF locally', async () => {
  const pdf = await readFile(invoice);
  const step = { connector: 'servicenow', operation: 'document' };
  const output = { document: { kind: 'file', name: 'invoice.pdf', mimeType: 'application/pdf', base64: pdf.toString('base64') } };
  const disabled = browserFixture(output, {});
  await assert.rejects(runConnector(step, {}, disabled.browser), /Enable the configured local source/);
  assert.equal(disabled.touched, false);

  const local = browserFixture(output, { servicenow: { enabled: true, share: false } });
  const result = await runConnector(step, {}, local.browser);
  assert.equal(result.document.kind, 'markdown');
  assert.match(result.document.markdown, /Grand total/);
  await assert.rejects(assertConnectorSharingAllowed(['servicenow'], local.browser), /permission to include source data/);

  const large = Buffer.alloc(1024 * 1024, 32).toString('base64');
  const chunked = browserFixture({ document: { ...output.document, base64: large } }, { servicenow: { enabled: true, share: true } });
  const scan = await runConnector(step, {}, chunked.browser);
  assert.equal(scan.document.kind, 'file');
  assert.equal(scan.document.base64, large);
  await assertConnectorSharingAllowed(['servicenow'], chunked.browser);
});
