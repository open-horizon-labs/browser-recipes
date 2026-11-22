const fieldName = /^[a-z][a-zA-Z0-9-]{0,63}$/;
const escapedMarkdown = /\\([\\_*{}[\]()<>#+.!|~&\x60-])/g;
const word = /[\p{L}\p{N}]/u;

function sourceText(value) {
  return value.normalize('NFC').replace(escapedMarkdown, '$1').replace(/\s+/gu, ' ').trim();
}

function containsText(haystack, needle) {
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const first = needle[0], last = needle.at(-1);
    if (!(word.test(first) && index > 0 && word.test(haystack[index - 1])) &&
        !(word.test(last) && index + needle.length < haystack.length && word.test(haystack[index + needle.length]))) {
      return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function pageText(markdown, page) {
  if (page === undefined) return markdown;
  const headings = [...markdown.matchAll(/^## Page (\d+)\s*$/gm)];
  const position = headings.findIndex(match => Number(match[1]) === page);
  return position < 0 ? undefined : markdown.slice(headings[position].index + headings[position][0].length, headings[position + 1]?.index);
}

function normalizedNumber(raw) {
  let value = raw.replace(/^\((.+)\)$/u, '-$1');
  if (/\s/u.test(value)) {
    if (!/^[+-]?\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/u.test(value)) return NaN;
    value = value.replace(/ /gu, '');
  }
  if (/^[+-]?\d{1,3}(?:,\d{3}){2,}$/u.test(value) || /^[+-]?\d{1,3}(?:\.\d{3}){2,}$/u.test(value)) {
    return Number(value.replace(/[.,]/gu, ''));
  }
  if (/^[+-]?\d+$/u.test(value)) return Number(value);
  const match = value.match(/^([+-]?)([\d.,]+)([.,])(\d+)$/u);
  if (!match) return NaN;
  const group = match[3] === '.' ? ',' : '.';
  const integer = match[2];
  const groups = integer.split(group);
  if (groups.some(part => !/^\d+$/.test(part))) return NaN;
  if (groups.length > 1 && (groups[0].length > 3 || groups.slice(1).some(part => part.length !== 3))) return NaN;
  if (groups.length === 1 && groups[0].length <= 3 && match[4].length === 3) return NaN;
  return Number(match[1] + groups.join('') + '.' + match[4]);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function normalizedDate(raw) {
  if (validDate(raw)) return raw;
  const match = raw.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (!match) return undefined;
  const [first, second] = [Number(match[1]), Number(match[2])];
  if (first <= 12 && second <= 12 && first !== second) return undefined;
  const [day, month] = first > 12 ? [first, second] : [second, first];
  const candidate = match[3] + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return validDate(candidate) ? candidate : undefined;
}

function matchesValue(value, raw, format) {
  if (format === 'number') return typeof value === 'number' && Number.isFinite(value) && value === normalizedNumber(raw);
  if (format === 'date') return validDate(value) && value === normalizedDate(raw);
  if (format === 'currency') return typeof value === 'string' && /^[A-Z]{3}$/.test(value) && value === raw.toUpperCase();
  return typeof value === 'string' && sourceText(value) === raw;
}

export function verifySourceFields({ document, fields }) {
  if (!document || !['markdown', 'file'].includes(document.kind) ||
      document.kind === 'markdown' && (typeof document.markdown !== 'string' || !document.markdown.trim() || document.markdown.length > 500_000)) {
    throw new Error('Provide a document read or converted attachment.');
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 64) {
    throw new Error('Provide up to 64 extracted fields with source quotes.');
  }
  const checked = {};
  const verified = {};
  const pages = new Map();
  function sourcePage(page) {
    if (!pages.has(page)) {
      const content = pageText(document.markdown, page);
      pages.set(page, content === undefined ? undefined : sourceText(content));
    }
    return pages.get(page);
  }
  for (const [name, field] of Object.entries(fields)) {
    if (!fieldName.test(name) || ['constructor', 'prototype'].includes(name) || !field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error('Use named extracted fields with a value and source quote.');
    }
    const { value, quote, page, raw = value == null ? undefined : String(value),
      format = typeof value === 'number' ? 'number' : 'text' } = field;
    if (!['text', 'number', 'date', 'currency'].includes(format) ||
        (value !== null && (typeof value !== 'string' || value.length > 1000) && (typeof value !== 'number' || !Number.isFinite(value))) ||
        (quote !== undefined && (typeof quote !== 'string' || quote.length > 1000)) ||
        (raw !== undefined && (typeof raw !== 'string' || raw.length > 1000)) ||
        (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 300))) {
      throw new Error('Check the value, source quote, or page for extracted field ' + name + '.');
    }
    const normalizedRaw = raw && sourceText(raw);
    const normalizedQuote = quote && sourceText(quote);
    let status;
    if (value === null) status = 'missing';
    else if (!normalizedQuote || !normalizedRaw || !containsText(normalizedQuote, normalizedRaw)) status = 'missing-evidence';
    else if (!matchesValue(value, normalizedRaw, format)) status = 'value-mismatch';
    else if (document.kind === 'file') status = 'review-scan';
    else {
      const scope = sourcePage(page);
      if (scope === undefined) status = 'page-unavailable';
      else if (!containsText(scope, normalizedQuote)) status = 'quote-not-in-source';
      else {
        status = 'verified-text';
        verified[name] = value;
      }
    }
    checked[name] = { value, status, ...(quote === undefined ? {} : { quote }), ...(raw === undefined ? {} : { raw }), ...(page === undefined ? {} : { page }) };
  }
  return { fields: checked, verified };
}

export function verifySum({ first, second, total }) {
  if (![first, second, total].every(Number.isFinite)) return { status: 'incomplete' };
  return { status: Math.abs(first + second - total) <= 0.01000001 ? 'matches' : 'mismatch' };
}

function evidencePath(path) {
  return typeof path === 'string' && path.length <= 256 &&
    path.split('.').every(segment => fieldName.test(segment) &&
      !['constructor', 'prototype'].includes(segment));
}

function sourceValue(source, path) {
  if (!evidencePath(path)) return undefined;
  for (const key of path.split('.')) {
    if (!source || typeof source !== 'object' || !Object.hasOwn(source, key)) return undefined;
    source = source[key];
  }
  return source;
}

function scalar(value) {
  return value === null || typeof value === 'string' && value.length <= 1000 ||
    typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';
}

export function verifySelectedMapping({ selected, mapped, 'allow-revised': allowRevised = false }) {
  if (!Array.isArray(selected) || !Array.isArray(mapped) || !selected.length || selected.length > 100 || mapped.length > 100) {
    throw new Error('Provide up to 100 selected items and proposed mappings.');
  }
  const source = new Map();
  for (const item of selected) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || source.has(item.id)) {
      throw new Error('Selected items need unique source identifiers.');
    }
    source.set(item.id, item);
  }
  const rejected = [];
  const confirmed = [];
  const reviewed = [];
  const seen = new Set();
  const counts = new Map();
  for (const row of mapped) counts.set(row?.id, (counts.get(row?.id) ?? 0) + 1);
  for (const row of mapped) {
    if (!row || typeof row.id !== 'string' || !source.has(row.id)) {
      rejected.push({ reason: 'unselected-item' });
      continue;
    }
    seen.add(row.id);
    if (counts.get(row.id) !== 1) {
      rejected.push({ id: row.id, reason: 'duplicate-mapping' });
      continue;
    }
    if (!row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields) ||
        !Object.keys(row.fields).length || Object.keys(row.fields).length > 32) {
      rejected.push({ id: row.id, reason: 'missing-fields' });
      continue;
    }
    const verified = {};
    const revisions = {};
    for (const [field, mapping] of Object.entries(row.fields)) {
      if (!evidencePath(field) || field.includes('.') || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        rejected.push({ id: row.id, reason: 'invalid-field' });
        continue;
      }
      const original = sourceValue(source.get(row.id), mapping.source);
      if (!scalar(original) || !scalar(mapping.value)) {
        rejected.push({ id: row.id, field, reason: 'missing-source-value' });
      } else if (Object.is(original, mapping.value)) {
        verified[field] = mapping.value;
      } else if (allowRevised === true && typeof mapping.reason === 'string' && mapping.reason.trim() && mapping.reason.length <= 500) {
        revisions[field] = { original, proposed: mapping.value, source: mapping.source, reason: mapping.reason };
      } else {
        rejected.push({ id: row.id, field, reason: 'changed-source-value' });
      }
    }
    if (Object.keys(verified).length) confirmed.push({ id: row.id, fields: verified });
    if (Object.keys(revisions).length) reviewed.push({ id: row.id, fields: revisions });
  }
  for (const id of source.keys()) {
    if (!seen.has(id)) rejected.push({ id, reason: 'omitted-item' });
  }
  return { confirmed, reviewed, rejected };
}
