import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { convertAttachment } from '../extension/attachment-convert.js';
import { verifySourceFields, verifySum } from '../extension/source-fields.js';
import { agentDocumentInputs, validateAgentAttachments } from '../extension/workflow-documents.js';
import { validateBundle } from '../extension/workflow.js';

const fixture = name => new URL('../examples/document-review/' + name, import.meta.url);
const bytes = name => readFile(fixture('site/files/' + name));
const total = { value: 135, raw: '135.00', quote: 'Grand total: 135.00', format: 'number', page: 1 };
const invoiceNumber = { value: 'INV-1042', quote: 'Invoice number: INV-1042', page: 1 };
const firstDate = { value: '2026-11-10', raw: '2026-11-10', quote: 'Invoice date: 2026-11-10', page: 1, format: 'date' };

test('confirms the source quote, exact value and cited page in a real text PDF', async () => {
  const bundle = validateBundle(JSON.parse(await readFile(fixture('catalog.json'), 'utf8')));
  assert.equal(bundle.workflows[0].id, 'review-invoice-fields');
  const document = await convertAttachment({
    name: 'invoice-text.pdf',
    mimeType: 'application/pdf',
    bytes: await bytes('invoice-text.pdf'),
  });
  assert.equal(document.kind, 'markdown');
  assert.deepEqual(agentDocumentInputs({ document }), { inputs: { document }, attachments: [] });
  const report = verifySourceFields({
    document,
    fields: {
      total,
      invoiceNumber,
      firstDate,
      otherPage: { ...total, page: 2 },
      changedValue: { ...total, value: 999 },
      inventedQuote: { value: 'PO-9999', quote: 'Purchase order: PO-9999', page: 1 },
      prefix: { value: 'INV-104', quote: 'Invoice number: INV-1042', page: 1 },
      absent: { value: null },
    },
  });
  assert.deepEqual(report.verified, { total: 135, invoiceNumber: 'INV-1042', firstDate: '2026-11-10' });
  assert.deepEqual(Object.values(report.fields).map(field => field.status), [
    'verified-text', 'verified-text', 'verified-text', 'page-unavailable',
    'value-mismatch', 'quote-not-in-source', 'missing-evidence', 'missing',
  ]);
});

test('a raster PDF stays a typed attachment and evidence visibly requires manual review', async () => {
  const raster = await bytes('invoice-scan.pdf');
  const converted = await convertAttachment({ name: 'invoice-scan.pdf', mimeType: 'application/pdf', bytes: raster });
  assert.equal(converted.kind, 'file');
  const document = { kind: converted.kind, name: converted.name, mimeType: converted.mimeType, base64: raster.toString('base64') };
  const { inputs, attachments } = agentDocumentInputs({ documents: [document, { kind: 'attachment', attachment: 1 }] });
  assert.deepEqual(inputs, { documents: [
    { kind: 'attachment', attachment: 1, name: document.name, mimeType: document.mimeType, bytes: raster.length },
    { kind: 'attachment', attachment: 1 },
  ] });
  assert.ok(!JSON.stringify(inputs).includes(document.base64));
  assert.deepEqual(attachments, [{ name: document.name, mimeType: document.mimeType, base64: document.base64 }]);
  const report = verifySourceFields({ document, fields: { total } });
  assert.deepEqual(report.verified, {});
  assert.equal(report.fields.total.status, 'review-scan');
});

test('agent attachments reject malformed, mislabeled, or oversized files', async () => {
  const doc = { name: 'scan.pdf', mimeType: 'application/octet-stream', base64: (await bytes('invoice-scan.pdf')).toString('base64') };
  assert.equal(validateAgentAttachments([doc])[0].mimeType, 'application/pdf');
  assert.throws(() => validateAgentAttachments([{ ...doc, mimeType: 'image/png' }]), /matching content/);
  assert.throws(() => validateAgentAttachments([{ ...doc, base64: 'not base64' }]), /invalid name, type, or encoding/);
  assert.throws(() => validateAgentAttachments([{ ...doc, name: '../scan.pdf' }]), /invalid name/);
  assert.throws(() => validateAgentAttachments(Array(5).fill(doc)), /four/);
  const large = Buffer.alloc(5 * 1024 * 1024);
  large.write('%PDF-1.4');
  const file = { ...doc, base64: large.toString('base64') };
  assert.throws(() => validateAgentAttachments([file, file]), /8 MiB in total/);
});

test('evidence rejects ambiguous normalized dates and supports printed decimal groupings', () => {
  const document = {kind: 'markdown', markdown: 'Date: 04/05/2026. Subtotal: 1 234,56. Tax: 20.44. Total: 1,255.00.'};
  const report = verifySourceFields({ document, fields: {
    date: { value: '2026-04-05', raw: '04/05/2026', quote: 'Date: 04/05/2026', format: 'date' },
    subtotal: { value: 1234.56, raw: '1 234,56', quote: 'Subtotal: 1 234,56' },
    tax: { value: 20.44, raw: '20.44', quote: 'Tax: 20.44' },
    total: { value: 1255, raw: '1,255.00', quote: 'Total: 1,255.00' },
  } });
  assert.equal(report.fields.date.status, 'value-mismatch');
  const { subtotal, tax, total } = report.verified;
  assert.deepEqual(verifySum({ first: subtotal, second: tax, total }), { status: 'matches' });
  assert.deepEqual(verifySum({ first: subtotal, second: tax, total: 0 }), { status: 'mismatch' });
  assert.deepEqual(verifySum({ first: subtotal, second: tax }), { status: 'incomplete' });
});

test('selection mapping cannot introduce unselected items or unacknowledged value changes', async () => {
  const { verifySelectedMapping } = await import('../extension/source-fields.js');
  const selected = [
    { id: 'one', fields: { vendor: 'Example', total: 20 } },
    { id: 'two', fields: { vendor: 'Other', total: 50 } },
  ];
  const mapped = [
    { id: 'one', fields: {
      name: { value: 'Example', source: 'fields.vendor' },
      amount: { value: 30, source: 'fields.total', reason: 'User asked to add a forecast variance' },
      invented: { value: 'Hidden', source: 'fields.secret' },
    } },
    { id: 'unselected', fields: { name: { value: 'Invented', source: 'fields.vendor' } } },
  ];
  const result = verifySelectedMapping({ selected, mapped });
  assert.deepEqual(result.confirmed, [{ id: 'one', fields: { name: 'Example' } }]);
  assert.deepEqual(result.reviewed, []);
  assert.deepEqual(result.rejected.map(item => item.reason), [
    'changed-source-value', 'missing-source-value', 'unselected-item', 'omitted-item',
  ]);
  const revised = verifySelectedMapping({ selected, mapped, 'allow-revised': true });
  assert.deepEqual(revised.reviewed[0].fields.amount, {
    original: 20, proposed: 30, reason: 'User asked to add a forecast variance', source: 'fields.total',
  });
  assert.deepEqual(revised.confirmed, result.confirmed);
  assert.deepEqual(verifySelectedMapping({ selected, mapped: [mapped[0], mapped[0]] }).confirmed, []);
});
