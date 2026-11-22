import { createDispatcher, safeError } from './runtime.js';
import { nativeResponseFrames } from './native-response.js';
import { getCatalog } from './settings.js';

const nativeHost = 'org.openhorizonlabs.tab_recipes';
const dispatch = createDispatcher(chrome, getCatalog);
let nativePort;
let bridgeStatus = 'Disabled';
let connectionTask;

async function manageBridge() {
  const { bridgeEnabled } = await chrome.storage.local.get('bridgeEnabled');
  if (!bridgeEnabled) {
    const previous = nativePort;
    nativePort = undefined;
    previous?.disconnect();
    bridgeStatus = 'Disabled';
    await chrome.alarms.clear('native-bridge');
    return;
  }
  if (!await chrome.alarms.get('native-bridge')) {
    await chrome.alarms.create('native-bridge', { periodInMinutes: 0.5 });
  }
  if (nativePort) return;

  bridgeStatus = 'Connecting';
  const port = chrome.runtime.connectNative(nativeHost);
  nativePort = port;
  port.onDisconnect.addListener(() => {
    const disconnected = chrome.runtime.lastError;
    if (nativePort !== port) return;
    nativePort = undefined;
    bridgeStatus = disconnected ? 'Native host unavailable' : 'Native host disconnected';
  });
  port.onMessage.addListener(message => {
    if (nativePort !== port || !Number.isSafeInteger(message?.id) && typeof message?.id !== 'string') return;
    bridgeStatus = 'Connected';
    void reply(port, message);
  });
  bridgeStatus = 'Bridge open';
}

async function reply(port, { id, command, args }) {
  let response;
  try {
    response = { id, result: await dispatch(command, args) };
  } catch (error) {
    response = { id, error: safeError(error) };
  }
  if (nativePort !== port) return;
  try {
    for (const frame of nativeResponseFrames(response)) port.postMessage(frame);
  } catch {
    // A disconnected native client has no reply channel.
  }
}

function refreshBridge() {
  const previous = connectionTask;
  connectionTask = (previous ?? Promise.resolve()).catch(() => {}).then(manageBridge).catch(() => {
    bridgeStatus = 'Native host unavailable';
  });
  return connectionTask;
}

chrome.runtime.onStartup.addListener(() => void refreshBridge());
chrome.runtime.onInstalled.addListener(() => void refreshBridge());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'native-bridge') void refreshBridge();
});
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('options.html')) return false;
  if (message?.command === 'bridge.refresh') {
    void refreshBridge().then(() => respond({ status: bridgeStatus }));
    return true;
  }
  if (message?.command === 'bridge.status') respond({ status: bridgeStatus });
  return false;
});
