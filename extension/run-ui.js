import { watchTabs } from './watch-tabs.js';
import { recipeEditor } from './recipe-edit-ui.js';
import { chatgptAgentRequest } from './chatgpt-agent-transport.js';
import { workflowInputs, workflowPrompt } from './workflow.js';
import { getWorkflows } from './settings.js';
import { agentDocumentInputs, reviewedDocumentInputs } from './workflow-documents.js';

const el = id => document.getElementById(id);
const names = {
  interrupted: 'Interrupted', queued: 'Queued', running: 'Running', waiting: 'Needs attention', paused: 'Paused',
  completed: 'Completed', complete: 'Completed', succeeded: 'Completed', cancelled: 'Cancelled',
  canceled: 'Cancelled', failed: 'Failed', pending: 'Pending', skipped: 'Skipped',
};
const tagNames = { 'edit-inputs':'Review inputs', 'edit-outputs':'Review outputs', fields: 'Input needed', selection: 'Selection needed', write: 'Write approval',
  'uncertain-write': 'Check a write', agent: 'Review what goes to ChatGPT', handoff: 'Needs your input', auth:'Sign-in needed', 'open-app':'Open the app', 'account-review':'Check account', 'background-tab':'Switch tabs', 'interrupt-check':'Check the result' };
let records = [];
let busy = false;
let view = 0;
let revision;
let connectionAction;
const urls = [];

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function action(label, callback, primary = false) {
  const result = node('button', label, primary ? 'primary' : '');
  result.type = 'button';
  result.addEventListener('click', () => void work(callback));
  return result;
}
function field(label, control) {
  const result = node('label', undefined, 'field');
  result.append(document.createTextNode(label), control);
  return result;
}
function check(label, input) {
  const result = node('label', undefined, 'check');
  result.append(input, document.createTextNode(' ' + label));
  return result;
}
function pretty(value) {
  return JSON.stringify(value, (key, entry) => key === 'base64' ? '[file contents]' : entry, 2);
}
function disclosure(title, value) {
  const result = node('details');
  result.append(node('summary', title), node('pre', pretty(value)));
  return result;
}
function notice(message = '', error = false) {
  el('notice').textContent = message;
  el('notice').toggleAttribute('data-error', error);
}
async function request(command, args = {}) {
  const response = await chrome.runtime.sendMessage({command, args});
  if (response?.error) throw new Error(response.error.message || 'The run request failed.');
  if (!response || !Object.hasOwn(response, 'result')) throw new Error('Reload this extension page and try again.');
  return response.result;
}
async function work(task, propagate = false) {
  if (busy) return;
  busy = true;
  const controls = el('record').querySelector('fieldset');
  if (controls) controls.disabled = true;
  notice('Working…');
  try { await task(); if (el('notice').textContent === 'Working…') notice(); }
  catch (error) { notice(error.message, true); if (propagate) throw error; }
  finally { busy = false; if (controls) controls.disabled = false; }
}
function runId() { return decodeURIComponent(location.hash.slice(1)); }
function status(record) { return record.pending ? 'Needs attention' : (names[record.status] ?? record.status); }
function tags(pending) { return [...new Set([...(pending?.tags ?? []), ...(pending?.context?.tags ?? [])])]; }
function recordTags(record) {
  return [...new Set([...tags(record.pending), ...(record.actions ?? []).flatMap(entry => tags(entry))])];
}
function timestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
}
function renderList() {
  const priorTag = el('tag').value;
  const available = [...new Set(records.flatMap(recordTags))].sort();
  el('tag').replaceChildren(new Option('All tags', ''), ...available.map(tag => new Option(tag, tag)));
  if (available.includes(priorTag)) el('tag').value = priorTag;
  const filtered = records.filter(record => (!el('scope').value || record.pending) &&
    (!el('tag').value || recordTags(record).includes(el('tag').value)));
  el('rows').replaceChildren();
  for (const record of filtered) {
    const row = node('li');
    const link = node('a', record.title || record.runId, 'run-name');
    link.href = '#' + encodeURIComponent(record.runId);
    row.append(link, node('span', status(record), 'run-state'));
    const meta = [timestamp(record.startedAt), record.parentRunId ? 'Child recipe run' : '', record.pending?.label,
      tags(record.pending).join(', ')].filter(Boolean);
    row.append(node('span', meta.join(' · '), 'meta'));
    el('rows').append(row);
  }
  el('empty').textContent = filtered.length ? '' : records.length ? 'No runs match these filters.' : 'Start a recipe or workflow to see its progress here.';
}
function parseJson(text) {
  try { return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')); }
  catch { throw new Error('Enter a valid JSON reply before continuing.'); }
}
function showOutputs(value, mount) {
  if (value?.kind === 'file' && typeof value.base64 === 'string') {
    const bytes = Uint8Array.from(atob(value.base64), char => char.charCodeAt(0));
    const link = node('a', 'Download ' + value.name);
    link.download = value.name;
    link.href = URL.createObjectURL(new Blob([bytes], {type: value.mimeType}));
    urls.push(link.href);
    mount.append(link);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const group = node('details');
      group.append(node('summary', key));
      showOutputs(entry, group);
      mount.append(group);
    }
  } else { mount.append(node('pre', typeof value === 'string' ? value : pretty(value))); }
}

async function renderModelAction(mount, record, context, resume) {
  const args = {runId: record.runId, actionId: record.pending.id};
  const review = await request('runs.agentReview', args);
  const data = node('textarea'); data.rows = 5;
  data.value = pretty(review.inputs ?? context.inputs);
  const guidance = node('textarea'); guidance.rows = 2; guidance.maxLength = 500;
  const stepId = record.pending.stepId ?? context.id.split(':')[0];
  const key = 'workflow-instructions-' + record.definitionId + '-' + stepId;
  guidance.value = (await chrome.storage.local.get(key))[key] ?? '';
  mount.append(field('Data to share (JSON)', data), field('Additional instructions (optional)', guidance));
  let files = [];
  if (review.attachments?.length) {
    const workflow = (await getWorkflows()).find(item => item.id === record.definitionId);
    const step = workflow?.steps.find(item => item.id === stepId);
    if (!step) throw new Error('The installed workflow changed. Reload the run to check its definition.');
    files = agentDocumentInputs(workflowInputs(step, new Map(Object.entries(record.entries ?? {})))).attachments;
  }
  const checks = [];
  for (const [index, file] of (review.attachments ?? []).entries()) {
    const input = node('input'); input.type = 'checkbox';
    const position = file.index ?? index + 1;
    checks.push({input, position});
    mount.append(check('Share ' + file.name + ' (' + file.mimeType + ')', input));
  }
  const prompt = node('textarea'); prompt.rows = 6; prompt.readOnly = true;
  function prepare() {
    const selected = checks.filter(item => item.input.checked).map(item => item.position);
    const input = parseJson(data.value);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a JSON object for the data to share.');
    const reviewed = reviewedDocumentInputs(input, files, new Set(selected));
    const indices = reviewed.attachments.map(file => files.indexOf(file) + 1);
    const base = workflowPrompt({instruction: context.instruction}, reviewed.inputs, context.fields ?? {});
    prompt.value = guidance.value.trim() ? base + '\n\nAdditional user instructions:\n' + guidance.value.trim() : base;
    return indices;
  }
  prepare();
  const preview = node('details');
  preview.append(node('summary','Exact prompt'), prompt);
  mount.append(preview);
  const reply = node('textarea'); reply.rows = 5;
  const model = node('select');
  let sentPrompt;
  const downloads = node('div');
  const send = action('Send to ChatGPT', async () => {
    const attachmentIndices = prepare();
    const response = await request('runs.agent', {...args, model:model.value, prompt:prompt.value, attachmentIndices});
    sentPrompt = prompt.value;
    reply.value = response.text;
    notice('Review the model reply before continuing.');
  });
  const prepareManual = action('Prepare prompt for manual chat', async () => {
    await request('runs.agentReview', args);
    const indices = prepare();
    downloads.replaceChildren();
    for (const index of indices) {
      showOutputs({kind:'file', ...files[index - 1]},downloads);
    }
    preview.open = true;
    prompt.focus(); prompt.select();
    notice(indices.length ? 'Copy the prompt and attach the selected files in this order, then paste the JSON reply below.'
      : 'Copy the reviewed prompt into your chat and paste its JSON reply below.');
  });
  const modes = node('div',undefined,'actions');
  modes.append(send, prepareManual);
  const connection = node('p');
  const signIn = action('Sign in with ChatGPT', async () => {
    await chatgptAgentRequest('signin');
    await loadModels();
  });
  async function loadModels() {
    try {
      const {models} = await chatgptAgentRequest('models');
      model.replaceChildren(...models.map(m => new Option(m.name || m.id, m.id)));
      send.disabled = !models.length;
      signIn.hidden = models.length > 0;
      connection.textContent = models.length ? '' : 'Sign in to choose a model.';
    } catch (error) {
      send.disabled = true; signIn.hidden = false;
      connection.textContent = error.message;
    }
  }
  const use = action('Use reviewed reply', async () => {
    await request('runs.agentReview', args);
    prepare();
    await resume({value: parseJson(reply.value), audit: {prompt: prompt.value, sent: sentPrompt === prompt.value}});
  },true);
  mount.addEventListener('input', event => {
    if (event.target === reply || event.target === model) return;
    reply.value = '';
    downloads.replaceChildren();
    sentPrompt = undefined;
    try { prepare(); } catch { prompt.value = ''; }
  });
  mount.append(field('ChatGPT model',model), connection, signIn, modes, downloads, field('JSON reply', reply), use);
  await loadModels();
}

async function renderPending(record, parent) {
  const pending = record.pending;
  const context = pending.context ?? record.context ?? {};
  const type = pending.tag ?? pending.type ?? tags(pending).find(tag => Object.hasOwn(tagNames, tag));
  const section = node('div', undefined, 'request');
  const form = node('form');
  const controls = node('fieldset');
  section.append(node('h3', pending.label || tagNames[type] || 'Action needed'), form);
  form.append(controls);
  parent.append(section);
  const info = [...new Set([tagNames[type], ...tags(pending).filter(tag => tag !== type)])].filter(Boolean);
  if (info.length) controls.append(node('p', info.join(' · '), 'meta'));
  if (context.item) controls.append(node('p', 'Item ' + (context.item.index + 1) + ' of ' + context.item.count + ' · ' + context.item.label));
  const connection = ['auth','open-app','account-review','background-tab'].includes(type);
  if (type !== 'background-tab' && (context.tabId != null || connection)) {
    const open = node('button', connection ? 'Open app in browser' : 'Open target tab ' + context.tabId);
    open.type = 'button';
    open.addEventListener('click', event => {
      if (event.isTrusted) void work(() => request('runs.open', {runId:record.runId, actionId:pending.id}));
    });
    controls.append(open);
  }
  const resume = async answer => {
    const next = await request('runs.resume', {runId: record.runId, actionId: pending.id, answer});
    if (runId() === record.runId) await load(true, next);
  };
  const primary = (label, answer) => {
    const submit = node('button', label, 'primary');
    submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      void work(() => resume(answer()));
    });
    controls.append(submit);
  };
  if (type === 'edit-inputs' || type === 'edit-outputs') {
    const phase = type === 'edit-inputs' ? 'inputs' : 'outputs';
    const args = {runId:record.runId, actionId:pending.id};
    controls.append(disclosure('Current ' + phase, context.data));
    const key = record.kind === 'workflow'
      ? JSON.stringify([record.definitionId,pending.stepId,context.adapterId])
      : record.adapterId + '/' + record.definitionId;
    controls.append(recipeEditor({phase, key, read:() => context.data,
      authorize:() => request('runs.editReview', args),
      plan:options => request('runs.editPlan', {...args, ...options}),
      apply:(_, edits) => work(() => resume({edits}), true)}));
    controls.append(action('Continue with current ' + phase, () => resume({edits:[]}), true));
    return;
  }
  if (type === 'agent') {
    controls.append(action('Review what goes to ChatGPT', async () => {
      const editor = node('div');
      await renderModelAction(editor, record, context, resume);
      controls.replaceChildren(editor);
    }, true));
    return;
  }
  if (context.inputs && Object.keys(context.inputs).length) controls.append(disclosure('Review step inputs', context.inputs));
  if (context.details !== undefined) controls.append(disclosure('Review details', context.details));
  if (type === 'interrupt-check') {
    controls.append(node('p','Execution stopped before the outcome was recorded. Check the destination for completed changes before continuing.'));
    primary('I checked the destination. Continue', () => ({}));
  } else if (connection) {
    const guidance = {
      auth: 'Sign in in the app tab. This run continues when the app is ready.',
      'open-app': 'Open the app. This run continues when the app is ready.',
      'account-review': 'Switch to the account approved for this app.',
      'background-tab': 'Leave the app open and select another tab. The run will continue automatically.',
    };
    controls.append(node('p', guidance[type]));
    controls.append(action('Check now', () => checkConnection(true)));
  } else if (type === 'fields') {
    const inputs = new Map();
    for (const [name, spec] of Object.entries(context.spec ?? {})) {
      const input = node('input');
      input.type = spec.type || 'text';
      input.required = input.type !== 'checkbox' && spec.required !== false;
      if (input.type === 'checkbox') {
        input.checked = (context.fields?.[name] ?? spec.default) === true;
        controls.append(check(spec.label || name, input));
      } else {
        input.value = context.fields?.[name] ?? spec.default ?? '';
        controls.append(field(spec.label || name, input));
      }
      inputs.set(name,input);
    }
    primary('Continue with these inputs', () => ({fields: Object.fromEntries([...inputs].map(([name, input]) =>
      [name, input.type === 'checkbox' ? input.checked : input.value]))}));
  } else if (type === 'selection') {
    const inputs = (context.choices ?? []).map(choice => {
      const input = node('input'); input.type = 'checkbox'; input.value = choice.index;
      controls.append(check(choice.label, input)); return input;
    });
    if (!inputs.length) controls.append(node('p','There are no items to select.'));
    primary('Use selected items', () => ({indices: inputs.filter(input => input.checked).map(input => Number(input.value))}));
  } else if (type === 'write' || type === 'uncertain-write') {
    const uncertain = type === 'uncertain-write';
    controls.append(node('p', uncertain ? (context.verificationFailed ? 'Verification could not confirm this write. Check the destination before deciding.' :
      'This write may already have taken effect. Check the destination before deciding.') : 'Review the destination and inputs before approving this write.'));
    const options = uncertain ? [
      ...(context.canVerify ? [['Verify in destination','verify']] : []), ['Mark as applied','mark-applied'], ['Mark as not applied','mark-not-applied']
    ] : [['Approve write','run']];
    const actions = node('div', undefined, 'actions');
    for (const [label, decision] of record.kind === 'recipe' ? options : [...options, ['Skip this item','skip']]) {
      actions.append(action(label, () => resume({decision}), decision === 'run' || decision === 'verify'));
    }
    controls.append(actions);
  } else if (type === 'handoff') {
    const reply = node('textarea'); reply.rows = 3;
    controls.append(field('Handoff result (optional JSON)', reply));
    primary('Continue', () => reply.value.trim() ? {value: parseJson(reply.value)} : {});
  } else controls.append(node('p','Refresh the run to check for an available action.'));
}
async function renderRecord(record) {
  el('run-title').textContent = record.title ?? record.runId;
  const group = document.createDocumentFragment();
  group.append(node('p', [status(record), timestamp(record.startedAt), record.finishedAt && 'Finished ' + timestamp(record.finishedAt)].filter(Boolean).join(' · ')));
  if (record.error) group.append(node('p', record.error.message ?? String(record.error)));
  if (record.interactive && record.status === 'running') group.append(node('p','Continue this step-by-step run in its original workflow window.'));
  if (record.pending) await renderPending(record, group);
  if (record.steps?.length) {
    group.append(node('h3','Steps'));
    const list = node('ol',undefined,'steps');
    for (const step of record.steps) {
      const row = node('li', step.label || step.title || step.id || step.stepId);
      row.append(node('small', names[step.status] ?? (step.finishedAt ? 'Completed' : record.pending?.stepId === step.id ? 'Waiting' : 'Started'), 'meta'));
      const children = step.childRunIds ?? [];
      for (const [position, child] of children.entries()) {
        const link = node('a', children.length > 1 ? 'Inspect recipe run ' + (position + 1) : 'Inspect recipe run'); link.href = '#' + encodeURIComponent(child);
        row.append(document.createTextNode(' · '), link);
      }
      const refs = step.inputs ?? {};
      if (Object.keys(refs).length) row.append(disclosure('Input sources', refs));
      if (step.outputs?.length) row.append(disclosure('Output names',step.outputs));
      list.append(row);
    }
    group.append(list);
  }
  const answered = (record.actions ?? []).filter(entry => entry.answeredAt);
  if (answered.length) {
    const actions = node('details');
    actions.append(node('summary','Action history (' + answered.length + ')'));
    const list = node('ol',undefined,'steps');
    for (const entry of answered) {
      const item = node('li', entry.label || tagNames[entry.tags?.[0]] || entry.stepId || 'Action');
      item.append(node('small', [...tags(entry), timestamp(entry.answeredAt)].filter(Boolean).join(' · '),'meta'));
      list.append(item);
    }
    actions.append(list); group.append(actions);
  }
  const info = node('details');
  info.append(node('summary','Run details'), node('p','Run ID ' + record.runId,'meta'));
  for (const [label, value] of [['Definition',record.definitionId],['Revision',record.revision],['Started by',record.caller],
    ['Adapter',record.adapterId],['Tab',record.tabId],['Inputs',record.inputs?.join(', ')],['Outputs',record.outputs?.join(', ')]]) {
    if (value) info.append(node('p', label + ' · ' + value,'meta'));
  }
  group.append(info);
  if (record.parentRunId) {
    const parent = node('a','View parent workflow run'); parent.href = '#' + encodeURIComponent(record.parentRunId);
    group.append(parent);
  }
  if (record.result !== undefined) {
    group.append(node('h3','Results'));
    showOutputs(record.result, group);
  } else if (!record.pending && !['queued','running'].includes(record.status)) {
    const result = node('div');
    result.append(action('View available results', async () => {
      const data = await request('runs.get', {runId: record.runId, includeData:true});
      result.replaceChildren();
      const outputs = data.result ?? data.entries;
      if (outputs != null && (typeof outputs !== 'object' || Object.keys(outputs).length)) showOutputs(outputs, result);
      else result.append(node('p','This run has no saved results.'));
    }));
    group.append(result);
  }
  if (record.pending || ['queued','running'].includes(record.status)) {
    group.append(action('Cancel run', async () => {
      if (!confirm('Cancel the remaining steps? Actions already completed will stay applied.')) return;
      await request('runs.cancel', {runId: record.runId}); await load(true);
    }));
  }
  if (!record.parentRunId && ['completed','cancelled','failed','interrupted'].includes(record.status)) {
    group.append(action('Delete run record', async () => {
      if (!confirm('Delete this run, its recipe history, and its saved results?')) return;
      await request('runs.forget', {runId:record.runId});
      location.hash = '';
    }));
  }
  el('record').replaceChildren(group);
}
async function load(force = false, returned) {
  const generation = ++view;
  const id = runId();
  el('listing').hidden = Boolean(id);
  el('inspection').hidden = !id;
  if (!id) {
    const rows = await request('runs.list');
    if (generation !== view) return;
    const fingerprint = JSON.stringify(rows);
    if (!force && fingerprint === revision) return;
    revision = fingerprint;
    records = rows;
    renderList();
  } else {
    let record = returned ?? await request('runs.get', {runId:id});
    if (generation !== view) return;
    const fingerprint = JSON.stringify([record.runId,record.status,record.pending?.id,record.steps,record.finishedAt]);
    if (!force && fingerprint === revision) return;
    if (record.pending) record = await request('runs.get', {runId:id, includeData:true});
    if (generation !== view) return;
    revision = fingerprint;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    await renderRecord(record);
    const next = ['auth','open-app','account-review','background-tab'].includes(record.pending?.tag)
      ? {runId:record.runId,actionId:record.pending.id} : undefined;
    const changed = next?.actionId !== connectionAction?.actionId;
    connectionAction = next;
    if (next && changed) scheduleConnectionCheck();
  }
}
async function checkConnection(manual = false) {
  const current = connectionAction;
  if (!current || runId() !== current.runId) return;
  const record = await request('runs.checkConnection',current);
  if (runId() !== current.runId) return;
  if (record.pending?.id !== current.actionId) await load(true,record);
  else if (manual) notice('The app still needs your attention.');
}

const scheduleConnectionCheck = watchTabs(async () => {
  if (!connectionAction) return;
  busy = true;
  try { await checkConnection(); }
  catch (error) { notice(error.message,true); }
  finally { busy = false; }
}, () => busy);

function navigate() {
  connectionAction = undefined;
  revision = undefined;
  el('record').replaceChildren();
  notice('Loading runs…');
  void load(true).then(() => { notice(); if (runId()) el('run-title').focus(); }).catch(error => notice(error.message,true));
}
el('refresh').addEventListener('click', () => void work(() => load(true)));
el('scope').addEventListener('change', renderList);
el('tag').addEventListener('change', renderList);
window.addEventListener('hashchange', navigate);
setInterval(() => {
  if (!busy && !document.hidden) void load().catch(error => notice(error.message,true));
}, 3000);
navigate();
