const nativeHost = 'org.openhorizonlabs.browser_recipes_agent';
const localUrl = 'http://127.0.0.1:18789/v1/agent';
const reportLimit = 1024 * 1024;
export const companionSetting = 'chatgptLocalPairing';
export const companionPermission = { origins: ['http://127.0.0.1/*'] };

function agentError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function receive(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response');
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > reportLimit) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function unwrap(message) {
  if (message?.error?.code && typeof message.error.message === 'string') {
    throw agentError(String(message.error.code).slice(0, 80), message.error.message.slice(0, 400));
  }
  if (!message || !Object.hasOwn(message, 'result')) {
    throw agentError('AGENT_PROTOCOL', 'The local ChatGPT helper returned an unexpected response.');
  }
  return message.result;
}

export async function companionAgentRequest(pairingCode, command, args = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(pairingCode ?? '')) {
    throw agentError('PAIRING_REQUIRED', 'Use the pairing code printed by the running local ChatGPT helper.');
  }
  if (!await chrome.permissions.contains(companionPermission)) {
    throw agentError('LOCAL_PERMISSION', 'Allow access to the local ChatGPT helper in Browser Recipes Settings.');
  }
  let response;
  try {
    response = await fetch(localUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + pairingCode, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(['signin', 'signout'].includes(command) ? 235_000 : command === 'plan' ? 160_000 : 50_000),
    });
  } catch {
    throw agentError('HELPER_UNAVAILABLE', 'Could not reach the paired helper. Check that it is still running on this computer.');
  }
  let body;
  try {
    body = await receive(response);
  } catch {
    throw agentError('AGENT_PROTOCOL', 'The paired helper returned an unexpected response.');
  }
  return unwrap(body);
}

export async function chatgptAgentRequest(command, args = {}) {
  const pairingCode = (await chrome.storage.local.get(companionSetting))[companionSetting];
  if (pairingCode) return companionAgentRequest(pairingCode, command, args);
  let message;
  try {
    message = await chrome.runtime.sendNativeMessage(nativeHost, { command, args });
  } catch {
    throw agentError('HELPER_UNAVAILABLE', 'The local ChatGPT helper is unavailable. Check the setup guide.');
  }
  return unwrap(message);
}
