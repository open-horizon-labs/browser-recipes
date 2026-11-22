import { RecipeError } from './schema.js';

const day = 86400000;
const dateLabel = new Intl.DateTimeFormat('en-US', {dateStyle:'long', timeZone:'UTC'});
const clean = text => text.replace(/[\s\u200e\u200f]+/g,' ').replace(/\s*[-–—]\s*/g,'–').trim();
const iso = ms => new Date(ms).toISOString().slice(0,10);
function fail(message) { throw new RecipeError('CALENDAR_RANGE',message); }

export function requestedRange(inputs) {
  const first = inputs['first-day'], last = inputs['last-day'];
  if (first === undefined && last === undefined) return null;
  const days = [first,last].map(s => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail('Supply both dates as YYYY-MM-DD.');
    const n = Date.parse(s+'T00:00:00Z');
    if (!Number.isFinite(n) || iso(n) !== s) fail('Invalid calendar date: '+s);
    return n;
  });
  if (days[1] < days[0]) fail('The last day precedes the first day.');
  return days;
}

export function weekStart(heading) {
  const text = clean(heading.split('\n')[0]);
  const match = /^(?:Week of )?([A-Za-z]+) (\d{1,2})(?:, (\d{4}))?/.exec(text);
  const year = match?.[3] ?? text.match(/, (\d{4})$/)?.[1];
  if (year) {
    const n = Date.parse(match[1]+' '+match[2]+', '+year+' 00:00 UTC');
    if (Number.isFinite(n) && (text === clean(dateLabel.formatRange(n,n+6*day)) ||
        text === 'Week of '+dateLabel.format(n) || text.startsWith('Week of '+dateLabel.format(n)+','))) return n;
  }
  fail('Open English-language Week view. Could not verify the week heading: '+text);
}

export async function readCalendarRange(bounds, heading, turn, readRows) {
  const [first,last] = bounds;
  let size = 0;
  let start = weekStart(await heading());
  const pages = [], events = [];
  const firstWeek = start + Math.floor((first-start)/(7*day))*7*day;
  if (Math.abs(firstWeek-start)/(7*day) + Math.floor((last-firstWeek)/(7*day)) > 52)
    fail('The range requires over 52 week changes. Open a nearer week or split the range.');
  async function move(direction) {
    const expected = start + direction*7*day;
    await turn(direction);
    const deadline = Date.now()+4000;
    while (weekStart(await heading()) !== expected) {
      if (Date.now() >= deadline) fail('Calendar did not advance to the expected week of '+iso(expected)+'.');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    start = expected;
  }
  while (start !== firstWeek) await move(Math.sign(firstWeek-start));
  while (true) {
    const before = await heading();
    if (weekStart(before) !== start) fail('Calendar changed during the read.');
    const rows = await readRows();
    size += new TextEncoder().encode(JSON.stringify(rows)).length;
    if (size > 760000) fail('The calendar range exceeds the result size limit. Split the range.');
    if (await heading() !== before) fail('Calendar changed during the read.');
    pages.push(before.split('\n')[0]);
    for (const row of rows) {
      if (start >= first && start+6*day <= last) { events.push(row); continue; }
      const label = (row.attributes?.['aria-label'] ?? '')+' '+row.text;
      const matches = [...new Set(label.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g) ?? [])];
      if (matches.length !== 1) fail('An event has an ambiguous date. Read the full week to review it.');
      const date = Date.parse(matches[0]+' 00:00 UTC');
      if (date >= first && date <= last) events.push(row);
    }
    if (start+7*day > last) break;
    await move(1);
  }
  return {events,range:iso(first)+' through '+iso(last)+' ('+pages.join('; ')+')'};
}
