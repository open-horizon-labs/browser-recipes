import { createDispatcher, safeError } from './runtime.js';
import { nativeResponseFrames } from './native-response.js';
import { originOf } from './schema.js';
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
let panelConfigured = false;
if (chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).then(
    () => { panelConfigured = true; },
    () => {}
  );
}
chrome.action.onClicked.addListener(() => {
  if (!panelConfigured) void chrome.tabs.create({ url: chrome.runtime.getURL('runner.html') });
});

async function runnerData() {
  const [catalog, eligibleTabs] = await Promise.all([dispatch('catalog'), dispatch('tabs')]);
  const tabs = await Promise.all(eligibleTabs.map(async candidate => {
    try {
      const tab = await chrome.tabs.get(candidate.tabId);
      const origin = originOf(tab.pendingUrl || tab.url);
      if (catalog.some(adapter => candidate.adapterIds.includes(adapter.id) && adapter.origin === origin)) {
        return { ...candidate, title: tab.title };
      }
    } catch {
      // The tab may close while the runner refreshes.
    }
    return null;
  }));
  return { catalog, tabs: tabs.filter(Boolean) };
}

async function handlePageRequest({ command, args }) {
  try {
    return { result: command === 'runner.list' ? await runnerData() : await dispatch(command, args) };
  } catch (error) {
    return { error: safeError(error) };
  }
}


chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const runner = sender.url === chrome.runtime.getURL('runner.html');
  const agent = sender.url === chrome.runtime.getURL('agent.html');
  if (runner || agent) {
    const command = message?.command;
    if (['catalog', 'tabs', 'run', 'runner.list'].includes(command)) {
      void handlePageRequest(message).then(respond);
      return true;
    }
    return false;
  }
  if (sender.url !== chrome.runtime.getURL('options.html')) return false;
  if (message?.command === 'bridge.refresh') {
    void refreshBridge().then(() => respond({ status: bridgeStatus }));
    return true;
  }
  if (message?.command === 'bridge.status') respond({ status: bridgeStatus });
  return false;
});
