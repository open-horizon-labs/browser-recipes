import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileCalendars, calendarIcs } from '../extension/calendar-sync.js';
import { validateRecipe } from '../extension/schema.js';
import { executeDom } from '../extension/dom.js';

const timed = (start, end, attrs = {}) => ({
  start: '2026-11-22T' + start,
  end: '2026-11-22T' + end,
  ...attrs,
});

test('normalizes timezone offsets and makes exact busy slots safe to rerun', () => {
  const first = timed('09:00-05:00', '10:00-05:00', { id: 'source-1' });
  const second = timed('10:00-05:00', '10:30-05:00');
  const copied = timed('14:00Z', '15:00Z', { title: 'Busy' });
  const { add, existing, conflicts } = reconcileCalendars([first, second, second], [copied]);
  assert.equal(existing.length, 1);
  assert.equal(existing[0].source.id, 'source-1');
  assert.equal(add.length, 1);
  assert.equal(add[0].start, '2026-11-22T15:00:00Z');
  assert.deepEqual(conflicts, []);
});

test('recognizes exact copies of overlapping Outlook occurrences on a rerun', () => {
  const meetings = [timed('09:00Z', '10:00Z'), timed('09:30Z', '10:30Z')];
  const { add, existing, conflicts } = reconcileCalendars(meetings, meetings);
  assert.deepEqual(add, []);
  assert.deepEqual(conflicts, []);
  assert.equal(existing.length, 2);
});

test('preserves overlaps, moved identities and destination-only events for review', () => {
  const source = [
    timed('12:00Z', '13:00Z', { id: 'moved' }),
    timed('14:00Z', '16:00Z'),
  ];
  const destination = [
    timed('17:00Z', '18:00Z', { id: 'moved' }),
    timed('15:00Z', '16:00Z'),
    timed('21:00Z', '22:00Z'),
  ];
  assert.deepEqual(reconcileCalendars(source, destination).conflicts.map(row => row.reason),
    ['destination-id-moved', 'destination-overlap', 'destination-only']);
  assert.deepEqual(reconcileCalendars(source, destination).add, []);
});

test('flags duplicate copies and duplicate source identities', () => {
  const first = timed('09:00Z', '10:00Z', { id: 'source-1' });
  const second = timed('10:00Z', '11:00Z', { id: 'source-1' });
  assert.equal(reconcileCalendars([first], [first, first]).conflicts[0].reason, 'destination-duplicate');
  const result = reconcileCalendars([first, second], []);
  assert.equal(result.add.length, 0);
  assert.deepEqual(result.conflicts.map(row => row.reason), ['source-id-conflict', 'source-id-conflict']);
});

test('validates event dates and uses exclusive end dates for all-day intersections', () => {
  const allDay = { start: '2026-11-22', end: '2026-11-23' };
  const morning = timed('01:00Z', '02:00Z');
  assert.equal(reconcileCalendars([morning], [allDay], { timeZone: 'America/New_York' }).add.length, 1);
  assert.equal(reconcileCalendars([morning], [allDay], { timeZone: 'UTC' }).add.length, 0);
  assert.throws(() => reconcileCalendars([{ start: '2026-02-30', end: '2026-03-04' }], []), /source event 1/);
  assert.throws(() => reconcileCalendars([timed('01:00', '02:00')], []), /source event 1/);
});

test('creates private ICS busy blocks with stable opaque identifiers', async () => {
  const allDay = { id: 'private-id', title: 'Private title\r\nATTENDEE:owner@example.test', start: '2026-11-22', end: '2026-11-23' };
  const instant = timed('01:00-05:00', '02:00-05:00');
  const file = await calendarIcs([allDay, instant]);
  assert.match(file, /^BEGIN:VCALENDAR\r\n/);
  assert.match(file, /DTSTART;VALUE=DATE:20261122\r\nDTEND;VALUE=DATE:20261123/);
  assert.match(file, /DTSTART:20261122T060000Z\r\nDTEND:20261122T070000Z/);
  assert.match(file, /SUMMARY:Busy\r\nCLASS:PRIVATE\r\nTRANSP:OPAQUE/);
  assert.doesNotMatch(file, /private-id|Private title|ATTENDEE/);
  const uid = /UID:([a-f0-9]+)@browser-recipes.local/.exec(file)[1];
  assert.match(await calendarIcs([{ ...allDay, title: 'New title' }]), new RegExp(uid));
});

test('event title copying escapes delimiters and folds UTF-8 content lines', async () => {
  const title = 'Review, slides; \\items\nATTENDEE:owner@example.test ' + '雪🌐'.repeat(27);
  const event = timed('01:00Z', '01:30Z', { title });
  const file = await calendarIcs([event], { copyTitles: true });
  const lines = file.split('\r\n');
  assert.ok(lines.every(line => Buffer.byteLength(line, 'utf8') <= 75));
  assert.ok(lines.some(line => line.startsWith(' ')));
  const unfolded = file.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:Review\\, slides\\; \\\\items\\nATTENDEE:owner@example.test ' + '雪🌐'.repeat(27)));
  assert.ok(!lines.some(line => line.startsWith('ATTENDEE:')));
});

test('schema and DOM read only reviewed public attributes on visible list rows', async t => {
  const origin = 'https://example.test';
  const list = { op: 'readList', selector: '.row', as: 'rows', attributes: ['aria-label', 'data-eventid'] };
  assert.doesNotThrow(() => validateRecipe({ id: 'test', title: 'Test', steps: [list] }, { origin }));
  assert.throws(() => validateRecipe({ id: 'test', title: 'Test', steps: [{ ...list, attributes: ['value'] }] }, { origin }), /Invalid recipe step/);
  class Element {
    constructor({ isVisible = true, password = false, attrs = {} } = {}) {
      this.isVisible = isVisible;
      this.password = password;
      this.attrs = attrs;
      this.innerText = 'Visible event';
    }
    getClientRects() { return this.isVisible ? [1] : []; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    matches(selector) { return this.password && selector.includes('password'); }
    closest() { return null; }
  }
  const previous = new Map();
  const rows = [
    new Element({ attrs: { 'aria-label': 'Event slot', 'data-eventid': 'stable' } }),
    new Element({ isVisible: false }),
  ];
  for (const [key, value] of Object.entries({
    HTMLElement: Element, location: { origin }, document: { querySelectorAll: () => rows },
    getComputedStyle: () => ({ visibility: 'visible' }),
  })) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  assert.deepEqual(await executeDom({ origin, ...list }), {
    ok: true, value: [{ text: 'Visible event', attributes: { 'aria-label': 'Event slot', 'data-eventid': 'stable' } }],
  });
  rows.push(new Element({ password: true }));
  assert.deepEqual(await executeDom({ origin, ...list }), { ok: false, code: 'UNSUPPORTED_CONTROL' });
  rows.length = 0;
  assert.deepEqual(await executeDom({ origin, ...list }), { ok: true, value: [] });
});
