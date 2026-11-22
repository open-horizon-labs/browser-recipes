import {bindingKey,adapterGranted} from './scope.js';
import {namedAccounts,setAccountLabel} from './accounts.js';
import { developerObserver } from './dev-observer.js';
import { createDispatcher, safeError } from './runtime.js';
import { nativeResponseFrames } from './native-response.js';
import {fetchCommunity,communitySelection} from './community.js';
import {mergeDefinitions,updateDefinitions} from './library.js';
import {bundled} from './settings.js';
import { RecipeError, originOf } from './schema.js';
import {createRunService} from './run-service.js';
import {chatgptAgentRequest} from './chatgpt-agent-transport.js';
import { getCatalog, installedBundle, assertWorkflowModelAccess, assertRecipeModelAccess } from './settings.js';

const nativeHost = 'org.openhorizonlabs.tab_recipes';
const dispatch = createDispatcher(chrome, getCatalog);
const runService = createRunService({browser:chrome,loadBundle:installedBundle,dispatch,allowModel:assertWorkflowModelAccess,allowRecipeModel:assertRecipeModelAccess,plan:chatgptAgentRequest});
const publicCommands = new Set(['definitions.list','runs.start','runs.list','runs.get','runs.resume','runs.cancel','runs.forget','run']);
const pageCommands = new Set([...publicCommands,'runs.open','runs.editReview','runs.editPlan','runs.agent','runs.agentReview','runs.interactiveBegin','runs.interactiveStep']);
const recorder = developerObserver(chrome, getCatalog);
const observerCommands = new Map([
  ['dev.record.start', recorder.start], ['dev.record.stop', recorder.stop], ['dev.capture', recorder.capture],
]);
const revokeObservation = () => void recorder.revoke().catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.devMode || changes.approvedOrigins)) revokeObservation();
});
chrome.permissions.onRemoved.addListener(revokeObservation);
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

// The CLI can install only a reviewed workflow from the same fixed source as Settings.
async function communityWorkflow(command,args) {
  const catalog = await fetchCommunity();
  const workflow = catalog.workflows.find(w => w.id === args.workflowId);
  if (!workflow) throw new RecipeError('INVALID_ARGUMENTS','Unknown community workflow.');
  const selection = communitySelection(catalog,{workflow});
  const bytes = new TextEncoder().encode(JSON.stringify(selection));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b => b.toString(16).padStart(2,'0')).join('');
  const review = {workflowId:workflow.id,digest,adapters:selection.adapters.map(a => ({
    id:a.id,origin:a.origin,recipes:a.recipes.map(r => r.id),
  }))};
  if (command === 'community.review') return review;
  if (args.digest !== digest) throw new RecipeError('INVALID_ARGUMENTS','Review this workflow revision before installing.');
  await updateDefinitions(await bundled,local => {
    for (const a of selection.adapters) {
      const previous = local.adapters.find(item => item.id === a.id);
      if (previous && previous.origin !== a.origin) throw new RecipeError('INVALID_ARGUMENTS','Installed adapter uses another origin. Review in Settings.');
    }
    return mergeDefinitions(local,selection);
  },async () => {});
  return review;
}

async function terminalRequest(command,args) {
  if (command === 'accounts.list' || command === 'accounts.label') {
    const available = [];
    for (const adapter of await getCatalog()) {
      if (!adapter.identity || !await adapterGranted(chrome,adapter)) continue;
      const key = bindingKey(adapter);
      const identity = (await chrome.storage.local.get(key))[key];
      if (command === 'accounts.label' && args.adapterId === adapter.id) {
        if (!identity) throw new RecipeError('ACCOUNT_NOT_CONFIGURED','Set the expected account in Settings first.');
        await setAccountLabel(chrome,adapter,args.label,identity);
        return {adapterId:adapter.id,label:args.label.trim(),identity};
      }
      available.push({adapterId:adapter.id,expectedAccount:identity,accounts:await namedAccounts(chrome,adapter)});
    }
    if (command === 'accounts.label') throw new RecipeError('ACCOUNT_NOT_CONFIGURED','Choose an approved adapter with an account identity.');
    return available;
  }
  if (command === 'community.review' || command === 'community.install') return communityWorkflow(command,args);
  if (publicCommands.has(command) || command === 'runs.agentReview' || command === 'runs.agent') return runService(command,args,'terminal');
  return dispatch(command,args);
}

async function reply(port, { id, command, args }) {
  let response;
  try {
    response = { id, result: await terminalRequest(command,args) };
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
    if (pageCommands.has(command)) return {result:await runService(command,args)};
    if (command === 'runner.list') return { result: await runnerData() };
    return { result: await (observerCommands.has(command) ? observerCommands.get(command)(args) : dispatch(command, args)) };
  } catch (error) {
    return { error: safeError(error) };
  }
}


chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.command === 'dev.record.event') {
    void recorder.event(message, sender).then(respond, () => respond({ keep: false }));
    return true;
  }
  const page = sender.url?.split(/[?#]/,1)[0];
  const runner = page === chrome.runtime.getURL('runner.html');
  const agent = page === chrome.runtime.getURL('agent.html');
  const runs = page === chrome.runtime.getURL('runs.html');
  if (runner || agent || runs) {
    const command = message?.command;
    if (pageCommands.has(command) || ['catalog', 'tabs', 'runner.list'].includes(command) ||
        command === 'dev.capture' ||
        agent && ['dev.inspect','dev.test','dev.failures','dev.record.start','dev.record.stop'].includes(command)) {
      void handlePageRequest(message).then(respond);
      return true;
    }
    return false;
  }
  if (page !== chrome.runtime.getURL('options.html')) return false;
  if (message?.command === 'bridge.refresh') {
    void refreshBridge().then(() => respond({ status: bridgeStatus }));
    return true;
  }
  if (message?.command === 'bridge.status') respond({ status: bridgeStatus });
  return false;
});
