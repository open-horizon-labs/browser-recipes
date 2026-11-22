import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowTransforms } from '../extension/workflow-transforms.js';

const reconcile = workflowTransforms['reconcile-intervals'];
const prepare = workflowTransforms['ics-attachment'];
const compare = workflowTransforms['compare-values'];
const range = { first: '2026-11-22', last: '2026-11-22', 'source-zone': 'America/New_York', 'destination-zone': 'America/New_York' };
const oneAttribute = workflowTransforms['one-attribute'];
const allDay = { start: '2026-11-22', end: '2026-11-23', title: 'Private review' };

test('calendar normalization applies a one-to-seven-day review window in source civil time', () => {
  const evenings = [
    { start: '2026-11-23T02:00Z', end: '2026-11-23T04:59Z', title: 'Inside at the source' },
    { start: '2026-11-23T05:00Z', end: '2026-11-23T06:00Z' },
  ];
  const events = { source: [...evenings, allDay], destination: [], unresolved: ['One unknown event'] };
  const result = reconcile({ ...range, events });
  assert.deepEqual(result.items.map(row => row.value.start), ['2026-11-23T02:00:00Z', '2026-11-22']);
  assert.match(result.items[0].label, /Inside at the source/);
  assert.match(result.items[1].label, /All day/);
  assert.deepEqual(result.details.outside, [{ start: '2026-11-23T05:00:00Z', end: '2026-11-23T06:00:00Z' }]);
  assert.deepEqual(result.details.unresolved, ['One unknown event']);
  assert.throws(() => reconcile({ ...range, first: '2026-02-30', events }), /date range/);
  assert.throws(() => reconcile({ ...range, last: '2026-11-29', events }), /date range/);
  assert.throws(() => reconcile({ ...range, 'source-zone': '', events }), /time zone/);
  assert.throws(() => reconcile({ ...range, events: { source: [], destination: [] } }), /unresolved lists/);
});

test('iCalendar attachment preparation keeps titles private by default', async () => {
  await assert.rejects(prepare({ events: [] }), /Select at least one/);
  const output = await prepare({ events: [allDay] });
  assert.equal(output.file.name, 'calendar-copy.ics');
  assert.equal(output.file.mimeType, 'text/calendar');
  const decode = value => Buffer.from(value.file.base64, 'base64').toString('utf8');
  assert.match(decode(output), /SUMMARY:Busy/);
  assert.doesNotMatch(decode(output), /Private review|calendar@example.test/);
  assert.match(decode(await prepare({ events: [allDay], 'copy-titles': true })), /SUMMARY:Private review/);
});

test('value comparison reports normalized text equality and validates scalar inputs', () => {
  assert.deepEqual(compare({ left: 'Same  title', right: 'Same title' }), {
    left: 'Same  title', right: 'Same title', equal: true,
  });
  assert.equal(compare({ left: 'Latest', right: 'Other headline' }).equal, false);
  assert.equal(compare({ left: 42, right: 42 }).equal, true);
  assert.throws(() => compare({ left: 'Latest' }), /Both values/);
});

test('attribute extraction requires exactly one reviewed row', () => {
  const row = { text: '', attributes: { 'aria-label': 'Reviewed label' } };
  assert.deepEqual(oneAttribute({ rows: [row] }), { value: 'Reviewed label' });
  assert.throws(() => oneAttribute({ rows: [] }), /exactly one row/);
  assert.throws(() => oneAttribute({ rows: [row, row] }), /exactly one row/);
  assert.throws(() => oneAttribute({ rows: [{ attributes: {} }] }), /requested attribute/);
});
