import { calendarIcs, reconcileCalendars } from './calendar-sync.js';
import { verifySelectedMapping, verifySourceFields, verifySum } from './source-fields.js';

function parseCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return NaN;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value ? epoch : NaN;
}

function reconcileIntervals({ events, first, last, 'source-zone': sourceZone, 'destination-zone': destinationZone }) {
  const firstDay = parseCalendarDate(first);
  const lastDay = parseCalendarDate(last);
  if (!Number.isFinite(firstDay) || !Number.isFinite(lastDay) || lastDay < firstDay || lastDay - firstDay > 6 * 86400000) {
    throw new Error('Enter a date range of one to seven days.');
  }

  sourceZone = typeof sourceZone === 'string' ? sourceZone.trim() : '';
  destinationZone = typeof destinationZone === 'string' ? destinationZone.trim() : '';
  const dateOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let sourceDate;
  let destinationDate;
  try {
    sourceDate = new Intl.DateTimeFormat('en-US', { ...dateOptions, timeZone: sourceZone });
    destinationDate = new Intl.DateTimeFormat('en-US', { ...dateOptions, timeZone: destinationZone });
  } catch {
    throw new Error('Enter a time zone such as America/New_York for each calendar.');
  }
  if (!Array.isArray(events?.source) || !Array.isArray(events.destination) || !Array.isArray(events.unresolved) ||
      events.unresolved.length > 500) {
    throw new Error('The agent comparison must contain source, destination, and unresolved lists.');
  }

  const { add, existing, conflicts } = reconcileCalendars(events.source, events.destination, {
    timeZone: sourceDate.resolvedOptions().timeZone === destinationDate.resolvedOptions().timeZone ? sourceZone : undefined,
  });
  const toSourceDay = epoch => {
    const parts = Object.fromEntries(sourceDate.formatToParts(epoch).map(part => [part.type, part.value]));
    return parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
  };
  const displayDate = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  const dates = new Intl.DateTimeFormat(undefined, { ...displayDate, timeZone: 'UTC' });
  const times = new Intl.DateTimeFormat(undefined, {
    ...displayDate, timeZone: sourceZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const items = [];
  const outside = [];
  for (const event of add) {
    const allDay = event.start.length === 10;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    const startDay = allDay ? event.start : toSourceDay(start);
    const endDay = allDay ? new Date(end - 1).toISOString().slice(0, 10) : toSourceDay(end - 1);
    if (startDay < first || endDay > last) {
      outside.push(event);
      continue;
    }
    const interval = allDay
      ? dates.formatRange(new Date(start), new Date(end - 1)) + ' · All day'
      : times.formatRange(new Date(start), new Date(end));
    items.push({ label: interval + (event.title ? ' · ' + event.title : ''), value: event });
  }
  return { items, details: { existing, conflicts, outside, unresolved: events.unresolved } };
}

async function icsAttachment({ events, 'copy-titles': copyTitles = false }) {
  if (!Array.isArray(events) || !events.length) throw new Error('Select at least one calendar block.');
  const bytes = new TextEncoder().encode(await calendarIcs(events, { copyTitles: copyTitles === true }));
  if (bytes.length > 384 * 1024) throw new Error('Select fewer blocks. This import exceeds the attachment size limit.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return { file: { name: 'calendar-copy.ics', mimeType: 'text/calendar', base64: btoa(binary) } };
}

function oneAttribute({ rows, attribute = 'aria-label' }) {
  const value = rows?.[0]?.attributes?.[attribute];
  if (!Array.isArray(rows) || rows.length !== 1 || typeof value !== 'string' ||
      !value.trim() || value.length > 1024) {
    throw new Error('The page read must contain exactly one row with the requested attribute.');
  }
  return { value };
}

function compareValues({ left, right }) {
  const comparable = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  if ([left, right].some(value => value === undefined ||
      (value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) {
    throw new Error('Both values must be text, numbers, booleans, or null.');
  }
  return { left, right, equal: Object.is(comparable(left), comparable(right)) };
}

function selectRows({ rows }) {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('Choose from up to 500 reviewed rows.');
  return { items: rows.flatMap(row => {
    const label = row?.label ?? row?.name ?? row?.text;
    return typeof label === 'string' && label.trim() && row.available !== false ? [{ label, value: row }] : [];
  }) };
}

function oneSelection({ items }) {
  if (!Array.isArray(items) || items.length !== 1 || !items[0] || typeof items[0] !== 'object') {
    throw new Error('Select exactly one item.');
  }
  return { value: items[0] };
}

export const workflowTransforms = Object.freeze({
  'reconcile-intervals': reconcileIntervals,
  'ics-attachment': icsAttachment,
  'one-attribute': oneAttribute,
  'compare-values': compareValues,
  'verify-source-fields': verifySourceFields,
  'verify-selected-mapping': verifySelectedMapping,
  'verify-sum': verifySum,
  'select-rows': selectRows,
  'one-selection': oneSelection,
});
