const dayMs = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timedPattern = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const maxEventCount = 500;

function dateEpoch(value) {
  if (!datePattern.test(value) || value.startsWith('0000-')) return NaN;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : NaN;
}

function instantEpoch(value) {
  const match = timedPattern.exec(value);
  return match && Number.isFinite(dateEpoch(match[1])) ? Date.parse(value) : NaN;
}

function calendarEntries(values, label) {
  if (!Array.isArray(values) || values.length > maxEventCount) {
    throw new Error('Provide up to 500 ' + label + ' events.');
  }
  return values.map((value, index) => {
    const invalid = () => new Error('Check the dates or identity of ' + label + ' event ' + (index + 1) + '.');
    if (!value || typeof value !== 'object' || typeof value.start !== 'string' ||
        typeof value.end !== 'string' || value.start.length > 30 || value.end.length > 30 ||
        (value.id !== undefined && (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512)) ||
        (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 512))) {
      throw invalid();
    }
    const allDay = datePattern.test(value.start);
    const parse = allDay ? dateEpoch : instantEpoch;
    const start = parse(value.start);
    const end = parse(value.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw invalid();
    const form = epoch => {
      const iso = new Date(epoch).toISOString();
      if (!/^\d{4}-/.test(iso) || iso.startsWith('0000-')) throw invalid();
      return allDay ? iso.slice(0, 10) : iso.replace('.000', '');
    };
    const event = { start: form(start), end: form(end) };
    if (value.id !== undefined) event.id = value.id;
    if (value.title !== undefined) event.title = value.title;
    return { allDay, start, end, event, slot: event.start + '/' + event.end };
  });
}

function overlaps(first, second, dayAt) {
  if (first.allDay === second.allDay) return first.start < second.end && second.start < first.end;
  const day = first.allDay ? first : second;
  const instant = first.allDay ? second : first;
  if (!dayAt) {
    // Without a shared calendar zone, allow for the widest civil offset.
    const offset = 14 * dayMs / 24;
    return instant.start < day.end + offset && day.start - offset < instant.end;
  }
  return dayAt(instant.start) < day.event.end && day.event.start <= dayAt(instant.end - 1);
}

export function reconcileCalendars(source, destination, { timeZone } = {}) {
  const sourceEntries = calendarEntries(source, 'source');
  const destinationEntries = calendarEntries(destination, 'destination');
  const dayFormat = timeZone === undefined ? null : new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dates = new Map();
  const dayAt = dayFormat && (epoch => {
    if (!dates.has(epoch)) {
      const parts = Object.fromEntries(dayFormat.formatToParts(epoch).map(part => [part.type, part.value]));
      dates.set(epoch, parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day);
    }
    return dates.get(epoch);
  });
  const add = [];
  const existing = [];
  const conflicts = [];
  const settled = new Set();
  const seenSlots = new Set();

  for (const entry of sourceEntries) {
    const sameId = other => entry.event.id !== undefined && entry.event.id === other.event.id;
    const matches = destinationEntries.filter(other => other.slot === entry.slot);
    const idMatches = destinationEntries.filter(sameId);
    const collisions = destinationEntries.filter(other => overlaps(entry, other, dayAt));
    let reason;
    let review = [];
    if (sourceEntries.some(other => sameId(other) && other.slot !== entry.slot)) {
      reason = 'source-id-conflict';
      review = idMatches;
    } else if (idMatches.some(other => other.slot !== entry.slot)) {
      reason = 'destination-id-moved';
      review = idMatches;
    } else if (matches.length > 1) {
      reason = 'destination-duplicate';
      review = matches;
    } else if (matches.length === 0 && collisions.length > 0) {
      reason = 'destination-overlap';
      review = collisions;
    }
    if (reason) {
      for (const other of review) settled.add(other);
      conflicts.push({ reason, source: entry.event, destination: review.map(other => other.event) });
      continue;
    }
    if (seenSlots.has(entry.slot)) continue;
    seenSlots.add(entry.slot);
    if (matches.length) {
      settled.add(matches[0]);
      existing.push({ source: entry.event, destination: matches[0].event });
    } else {
      add.push(entry.event);
    }
  }

  for (const entry of destinationEntries) {
    if (!settled.has(entry)) conflicts.push({ reason: 'destination-only', destination: [entry.event] });
  }
  return { add, existing, conflicts };
}

function icalTime(value) {
  return value.replace(/[:-]/g, '');
}

function icalText(value) {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[\\,;]/g, '\\$&').replace(/\r\n?|\n/g, '\\n');
}

function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  let output = '';
  let length = 0;
  for (const character of line) {
    const width = encoder.encode(character).length;
    if (length + width > 75) {
      output += '\r\n ';
      length = 1;
    }
    output += character;
    length += width;
  }
  return output;
}

export async function calendarIcs(events, { copyTitles = false } = {}) {
  const entries = calendarEntries(events, 'import');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Browser Recipes//Calendar Import//EN', 'CALSCALE:GREGORIAN'];
  const timestamp = icalTime(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const identities = new Set();
  for (const { event, allDay, slot } of entries) {
    const source = event.id ? 'id:' + event.id : 'slot:' + slot;
    if (identities.has(source)) throw new Error('The import contains a repeated event identity.');
    identities.add(source);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const uid = [...new Uint8Array(digest)].slice(0, 24).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const property = allDay ? ';VALUE=DATE:' : ':';
    const title = copyTitles && event.title?.trim() ? icalText(event.title) : 'Busy';
    lines.push('BEGIN:VEVENT', 'UID:' + uid + '@browser-recipes.local', 'DTSTAMP:' + timestamp,
      'DTSTART' + property + icalTime(event.start), 'DTEND' + property + icalTime(event.end),
      'SUMMARY:' + title, 'CLASS:PRIVATE', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  return [...lines.map(foldLine), 'END:VCALENDAR', ''].join('\r\n');
}
