const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4;

function fileType(head) {
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.slice(0, 1024).includes('%PDF-')) return 'application/pdf';
}

function decodedLength(base64) {
  return base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

export function validateAgentAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    throw new Error('Choose up to four document or image attachments.');
  }
  let totalBytes = 0;
  return attachments.map(file => {
    const { name, mimeType, base64 } = file ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(name) ||
        typeof mimeType !== 'string' || typeof base64 !== 'string' || !base64 ||
        base64.length > MAX_BASE64 || base64.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
      throw new Error('An agent attachment has an invalid name, type, or encoding.');
    }
    totalBytes += decodedLength(base64);
    if (totalBytes > MAX_BYTES) throw new Error('Agent attachments exceed 8 MiB in total.');
    const detected = fileType(atob(base64.slice(0, 1372)));
    const declared = mimeType.toLowerCase();
    if (!detected || (declared !== 'application/octet-stream' && declared !== detected)) {
      throw new Error('Agent attachments must be PDF, PNG, JPEG, GIF, or WebP with matching content.');
    }
    return { name, mimeType: detected, base64 };
  });
}

export function agentDocumentInputs(inputs) {
  const attachments = [];
  const marker = Symbol();
  let nodes = 0;
  function collect(value, depth) {
    if (++nodes > 20_000 || depth > 20) throw new Error('Agent inputs contain too many structured values.');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(entry => collect(entry, depth + 1));
    if (value.kind === 'file') {
      const file = { name: value.name, mimeType: value.mimeType, base64: value.base64 };
      attachments.push(file);
      return { [marker]: attachments.length };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, collect(entry, depth + 1)]));
  }
  const safe = collect(inputs, 0);
  const files = validateAgentAttachments(attachments);
  function describe(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(describe);
    if (Object.hasOwn(value, marker)) {
      const attachment = value[marker];
      const file = files[attachment - 1];
      return { kind: 'attachment', attachment, name: file.name, mimeType: file.mimeType, bytes: decodedLength(file.base64) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, describe(entry)]));
  }
  return { inputs: describe(safe), attachments: files };
}

export function reviewedDocumentInputs(inputs, files, selected) {
  const attachments = [];
  const indexed = new Map();
  function review(value, depth) {
    if (depth > 20) throw new Error('Agent inputs contain too many structured values.');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(entry => review(entry, depth + 1));
    if (value.kind === 'attachment' && Object.hasOwn(value, 'attachment')) {
      const original = value.attachment;
      if (!Number.isSafeInteger(original) || !files[original - 1]) throw new Error('The reviewed data refers to an unknown attachment.');
      if (!selected.has(original)) return { kind: 'omitted-attachment' };
      const file = files[original - 1];
      if (!indexed.has(original)) {
        attachments.push(file);
        indexed.set(original, attachments.length);
      }
      return { kind: 'attachment', attachment: indexed.get(original), name: file.name, mimeType: file.mimeType, bytes: decodedLength(file.base64) };
    }
    if (value.kind === 'file') throw new Error('Use the attachment options to send a file.');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, review(entry, depth + 1)]));
  }
  return { inputs: review(inputs, 0), attachments };
}
