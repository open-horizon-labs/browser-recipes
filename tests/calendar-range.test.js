import assert from 'node:assert/strict';
import test from 'node:test';
import { requestedRange, weekStart, readCalendarRange } from '../extension/calendar-range.js';

test('range is optional and dates must form a valid inclusive pair', () => {
  assert.equal(requestedRange({}),null);
  for (const [first,last] of [['2026-02-30','2026-03-01'],['2026-11-14','2026-11-08'],['2026-11-08',undefined]]) {
    assert.throws(()=>requestedRange({'first-day':first,'last-day':last}),{code:'CALENDAR_RANGE'});
  }
});
test('reads only dated rows inside a cross-week range and verifies each heading', async () => {
  const headings=['November 8–14, 2026','Week of November 15, 2026, 2 events'];
  let page=1;
  const moves=[];
  const rows=[['November 13, 2026','November 14, 2026'],['November 15, 2026','November 16, 2026']];
  const range=requestedRange({'first-day':'2026-11-14','last-day':'2026-11-15'});
  const result=await readCalendarRange(range,()=>headings[page],d=>{moves.push(d);page+=d;},
    ()=>rows[page].map(text=>({text})));
  assert.deepEqual(moves,[-1,1]);
  assert.deepEqual(result.events.map(r=>r.text),['November 14, 2026','November 15, 2026']);
  assert.throws(()=>weekStart('November 2026'),{code:'CALENDAR_RANGE'});
});
