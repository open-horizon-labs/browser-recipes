import { convertAttachment } from './attachment-convert.js';

const maxBytes = 12 * 1024 * 1024;
const maxFileBytes = 8 * 1024 * 1024;
const chunkBytes = 576 * 1024;
const maxChunks = Math.ceil(maxBytes / chunkBytes);
const hostPrefix = 'org.openhorizonlabs.browser_recipes_source_';
export const connectorName = /^[a-z][a-z0-9-]{0,47}$/;
export const connectorOperations = Object.freeze(['records', 'attachments', 'document']);

export async function assertConnectorSharingAllowed(sources, browser = chrome) {
  const { connectors = {} } = await browser.storage.local.get('connectors');
  for (const source of sources) {
    if (!connectorName.test(source) || !Object.hasOwn(connectors, source) ||
        connectors[source]?.enabled !== true || connectors[source]?.share !== true) {
      throw new Error('Connector data is blocked from model sharing. Enable sharing for the configured source in Settings.');
    }
  }
}

function requestSource(browser, connector, operation, args) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const scheme = hostPrefix + connector.replaceAll('-', '_');
    const port = browser.runtime.connectNative(scheme);
    const buffers = [];
    let total, bytes = 0;
    let settled = false;
    let timer;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.disconnect();
      if (error) reject(error);
      else resolve(value);
    }
    function complete(message) {
      if (message.id !== id) throw new Error();
      if (message.error) {
        const text = typeof message.error.message === 'string' ? message.error.message.slice(0, 300) : '';
        finish(new Error(text || 'The configured source denied the request.'));
      } else if (Object.hasOwn(message, 'result')) {
        finish(null, message.result);
      } else {
        throw new Error();
      }
    }
    timer = setTimeout(() => finish(new Error('The source request timed out.')), 65_000);
    port.onDisconnect.addListener(() => {
      const lastError = browser.runtime.lastError;
      finish(new Error(lastError ? 'The configured local source host is unavailable.' : 'The source closed the connection.'));
    });
    port.onMessage.addListener(message => {
      try {
        if (message?.id !== id) throw new Error();
        const { chunk } = message;
        if (!chunk) {
          if (buffers.length && !message.error) throw new Error();
          complete(message);
          return;
        }
        const { index, total: count, data } = chunk;
        if (index !== buffers.length || !Number.isInteger(count) || count < 2 || count > maxChunks ||
            (total !== undefined && total !== count) || typeof data !== 'string' ||
            !data || data.length > chunkBytes * 4 / 3) throw new Error();
        total = count;
        const raw = atob(data);
        bytes += raw.length;
        if (!raw.length || bytes > maxBytes || (index + 1 < count && raw.length !== chunkBytes)) throw new Error();
        buffers.push(Uint8Array.from(raw, character => character.charCodeAt(0)));
        if (buffers.length !== total) return;
        const output = new Uint8Array(bytes);
        let offset = 0;
        for (const buffer of buffers) {
          output.set(buffer, offset);
          offset += buffer.length;
        }
        complete(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)));
      } catch {
        finish(new Error('The configured source returned an invalid response.'));
      }
    });
    try {
      port.postMessage({ id, operation, args });
    } catch {
      finish(new Error('Could not reach the configured local source.'));
    }
  });
}

async function convertSourceDocument(result) {
  const document = result?.document;
  if (!document || document.kind !== 'file' || typeof document.name !== 'string' || !document.name.trim() ||
      document.name.length > 180 || /[\/\\\x00-\x1f\x7f]/.test(document.name) || typeof document.mimeType !== 'string' ||
      typeof document.base64 !== 'string' || document.base64.length > Math.ceil(maxFileBytes / 3) * 4 ||
      !/^[a-z0-9+/]+={0,2}$/i.test(document.base64) || document.base64.length % 4 !== 0) {
    throw new Error('The configured source did not return a valid document.');
  }
  const raw = atob(document.base64);
  if (!raw.length || raw.length > maxFileBytes) throw new Error('The configured source exceeded the document size limit.');
  const converted = await convertAttachment({
    name: document.name, mimeType: document.mimeType, bytes: Uint8Array.from(raw, character => character.charCodeAt(0)),
  });
  return { document: converted.kind === 'file' ? document : converted };
}

export async function runConnector(step, inputs, browser = chrome) {
  const { connector, operation } = step;
  if (typeof connector !== 'string' || !connectorName.test(connector) || !connectorOperations.includes(operation)) {
    throw new Error('Choose a configured read-only source operation.');
  }
  const { connectors = {} } = await browser.storage.local.get('connectors');
  if (!Object.hasOwn(connectors, connector) || connectors[connector]?.enabled !== true) {
    throw new Error('Enable the configured local source in Settings first.');
  }
  const result = await requestSource(browser, connector, operation, inputs);
  return operation === 'document' ? convertSourceDocument(result) : result;
}
