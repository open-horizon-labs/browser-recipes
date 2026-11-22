import { chatgptAgentRequest } from './chatgpt-agent-transport.js';
import { assertConnectorSharingAllowed, runConnector } from './connector.js';
import { agentDocumentInputs, reviewedDocumentInputs } from './workflow-documents.js';
import { availableGuideActions, guidePrompt, guideReply } from './guide.js';
import { assertWorkflowModelAccess, getWorkflows } from './settings.js';
import { canWrite, checkpointSummary, currentItem, mapItemInputs, newCheckpoint, updateCheckpoint, writeItems } from './write-session.js';
import { executeTransform, roleAdapters, workflowInputs, workflowPrompt } from './workflow.js';

const el = id => document.getElementById(id);
const results = new Map();
const selectedTabs = new Map();
let workflows = [];
let tabs = [];
let workflow;
let index = 0;
let busy = false;
const historyPrefix = 'workflow-history-';
const savedPrefix = 'workflow-saved-';
const checkpointPrefix = 'workflow-write-';
const writeCheckpoints = new Map();
let workflowRunId = crypto.randomUUID();
let rolesLocked = false;
let restored = false;
let inspected;
let recording;
let pendingGuide;
const guideConversation = [];
let connected = false;
let models = [];
let chosenModel = '';

function node(tag, text, attrs = {}) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function report(message = '', error = false) {
  el('status').textContent = message;
  el('status').toggleAttribute('data-error', error);
}

async function request(command, args = {}, native = false) {
  if (native) {
    try {
      return await chatgptAgentRequest(command, args);
    } catch (error) {
      if (error.code === 'SIGN_IN_REQUIRED' || error.code === 'SESSION_EXPIRED') {
        connected = false;
        models = [];
        el('account').textContent = 'ChatGPT sign-in needs renewal.';
        el('signin').hidden = false;
        if (error.code === 'SESSION_EXPIRED') el('signout').hidden = true;
        renderModel();
      }
      throw error;
    }
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({ command, args });
  } catch {
    throw new Error('The extension is unavailable. Reload this page and try again.');
  }
  if (response?.error) {
    const { code, message, step, runId } = response.error;
    const context = [code, step ? `Recipe step ${step}` : '', runId ? `Run ${runId}` : ''].filter(Boolean).join(' · ');
    const error = new Error(message ? `${message}${context ? ` (${context})` : ''}` : context || 'The request failed.');
    error.runId = runId;
    error.recipeFailure = response.error;
    throw error;
  }
  if (!response || !Object.hasOwn(response, 'result')) throw new Error('The extension returned no result.');
  return response.result;
}

function roleSelected() {
  return Object.entries(workflow?.tabs ?? {}).every(([role, definition]) =>
    tabs.some(tab => tab.tabId === selectedTabs.get(role) && roleAdapters(definition).some(id => tab.adapterIds.includes(id))));
}

function updateControls() {
  el('workflow').disabled = busy || !workflows.length;
  el('refresh').disabled = busy;
  el('reset').disabled = busy;
  el('save-results').disabled = busy;
  for (const button of el('history-items').querySelectorAll('button')) button.disabled = busy;
  for (const id of ['refresh-history', 'clear-history', 'dev-tab', 'inspect', 'test-draft', 'failures']) el(id).disabled = busy;
  el('download-inspection').disabled = busy || inspected === undefined;
  el('record-start').disabled = busy || Boolean(recording);
  el('record-stop').disabled = busy;
  el('signin').disabled = busy;
  el('signout').disabled = busy;
  for (const picker of el('roles').querySelectorAll('select')) {
    picker.disabled = busy || rolesLocked || picker.options.length <= 1;
  }
  const form = el('current').querySelector('fieldset');
  if (form) form.disabled = busy || !roleSelected();
  el('prepare-guide').disabled = busy || !workflow;
  el('ask-guide').disabled = busy || !models.length;
  el('use-guide-reply').disabled = busy;
  const step = workflow?.steps[index];
  el('guide-status').textContent = !workflow
    ? 'Choose an installed workflow to see the actions available.'
    : !step ? 'The workflow is complete. Review the results or start over.'
      : !roleSelected() ? 'Choose an approved tab for each role.'
        : canAdvance(step) ? 'Run the available preparation steps. The workflow will stop for review.'
          : step.op === 'agent' ? 'Review the data and attachments before running the model step.'
            : step.op === 'recipe' && step.effect === 'write' ? 'Review the recipe inputs and the destination tab before running this step.'
              : 'Complete or review the current step before continuing.';
}

async function act(progress, task, trackStep = false) {
  if (busy) return;
  busy = true;
  updateControls();
  report(progress);
  try {
    report(await task());
  } catch (error) {
    report(error.message, true);
    if (trackStep && workflow?.steps[index]) {
      const step = workflow.steps[index];
      const failure = { workflow:workflow.id, step:step.id, operation:step.op,
        completedSteps:[...results.keys()], error:error.recipeFailure ?? {message:error.message} };
      el('workflow-failure-log').value = JSON.stringify(failure, null, 2);
      el('workflow-failure').hidden = false;
      void appendHistory(step, 'Failed', error.runId).catch(() => {});
    }
  } finally {
    busy = false;
    updateControls();
  }
}

function button(id, label, action, primary = false) {
  const element = node('button', label, { type: 'button', id });
  if (primary) element.className = 'primary';
  element.addEventListener('click', action);
  return element;
}

function field(id, label, control) {
  control.id = id;
  const group = node('label', undefined, { class: 'workflow-field', for: id });
  group.append(node('span', label), control);
  return group;
}

function details(label, content) {
  const element = node('details');
  element.append(node('summary', label), content);
  return element;
}

function preview(value) {
  return JSON.stringify(value, (key, entry) =>
    key === 'base64' && typeof entry === 'string' ? '[file contents]' : entry, 2) ?? '';
}

function renderRoles() {
  el('roles').replaceChildren();
  for (const [id, role] of Object.entries(workflow?.tabs ?? {})) {
    const choices = tabs.filter(tab => roleAdapters(role).some(id => tab.adapterIds.includes(id)));
    const picker = node('select');
    picker.append(new Option(choices.length ? 'Choose a tab' : 'No approved tabs open', ''));
    for (const tab of choices) picker.append(new Option(`${tab.title || role.label} · tab ${tab.tabId}`, tab.tabId));
    picker.value = String(selectedTabs.get(id) ?? '');
    if (picker.selectedIndex < 0) picker.selectedIndex = 0;
    picker.addEventListener('change', () => {
      if (picker.value) selectedTabs.set(id, Number(picker.value));
      else selectedTabs.delete(id);
      render();
      el(`tab-${id}`).focus({ preventScroll: true });
      report();
    });
    el('roles').append(field(`tab-${id}`, role.label, picker));
  }
}

function renderSteps() {
  const list = el('steps');
  list.replaceChildren();
  for (const [position, step] of workflow.steps.entries()) {
    const item = node('li', step.label);
    if (position === index) item.setAttribute('aria-current', 'step');
    if (position < index) {
      item.append(node('small', 'Complete'));
      const { value, audit } = results.get(step.id);
      item.append(details('View result', node('pre', preview(value))));
      if (audit?.prompt) item.append(details(audit.sent ? 'View sent prompt' : 'View prepared prompt', node('pre', audit.prompt)));
      if (audit?.runId) item.append(node('small', `Run ${audit.runId}`));
    }
    list.append(item);
  }
}

function fieldsFor(step, mount) {
  const controls = new Map();
  for (const [id, spec] of Object.entries(step.fields ?? {})) {
    const control = node('input', undefined, { type: spec.type });
    control.required = spec.type !== 'checkbox' && spec.required !== false;
    if (spec.type === 'checkbox') control.checked = spec.default === true;
    else control.value = spec.default ?? '';
    mount.append(field(`field-${id}`, spec.label, control));
    controls.set(id, control);
  }
  return () => Object.fromEntries([...controls].map(([id, control]) => {
    if (control.required && !control.value.trim()) throw new Error(`Complete ${step.fields[id].label}.`);
    return [id, control.type === 'checkbox' ? control.checked : control.value];
  }));
}

function connectorSources(step) {
  const refs = [...Object.values(step.inputs ?? {}), ...(step.repeat ? [step.repeat.items] : [])];
  return new Set([
    ...(step.op === 'connector' ? [step.connector] : []),
    ...refs.flatMap(ref => results.get(ref.split('.')[0])?.sources ?? []),
  ]);
}

async function allowModelShare(step) {
  await assertWorkflowModelAccess(workflow, step, results);
  await assertConnectorSharingAllowed(connectorSources(step));
}

function saveStep(step, value, fields = {}, selected = [], audit) {
  results.set(step.id, { value, fields, selected, audit, sources: [...connectorSources(step)] });
  clearGuideRequest();
  rolesLocked = true;
  restored = false;
  index += 1;
  void appendHistory(step, 'Complete', audit?.runId).catch(() => {});
}

async function executeRecipe(step, inputs, fields = {}, recipeId = step.recipeId) {
  const tabId = selectedTabs.get(step.tab);
  const target = tabs.find(tab => tab.tabId === tabId);
  const adapterId = roleAdapters(workflow.tabs[step.tab]).find(id => target?.adapterIds.includes(id));
  if (!adapterId) throw new Error("The selected tab no longer matches its adapter.");
  const interactiveInputs = Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, String(value)]));
  return { ...await request('run', { tabId, adapterId, recipeId, inputs: { ...inputs, ...interactiveInputs } }), adapterId };
}

async function runRecipe(step, inputs, fields = {}) {
  const result = await executeRecipe(step, inputs, fields);
  saveStep(step, result.outputs, fields, [], { runId: result.runId, adapterId: result.adapterId });
}

function canAdvance(step) {
  if (!step || Object.keys(step.fields ?? {}).length) return false;
  return (step.op === 'recipe' && step.effect === 'read') || (step.op === 'transform' && !step.select);
}

function afterStep() {
  render();
  el('current').querySelector('[tabindex="-1"]')?.focus({ preventScroll: true });
  return index === workflow.steps.length ? 'Workflow complete.' : '';
}

async function advance() {
  while (canAdvance(workflow.steps[index])) {
    const step = workflow.steps[index];
    const inputs = workflowInputs(step, results);
    report(`Running ${step.label}…`);
    if (step.op === 'recipe') await runRecipe(step, inputs);
    else saveStep(step, await executeTransform(step, inputs, {}));
    render();
  }
  return afterStep() || 'Review the next step.';
}

function journalKey(step) {
  return checkpointPrefix + workflow.id + '/' + step.id;
}

async function lockedCheckpoint(key, task) {
  // One extension window can checkpoint this workflow step at a time.
  return await navigator.locks.request(key, async () => {
    const stored = (await chrome.storage.local.get(key))[key];
    return await task(stored);
  });
}

async function persistCheckpoint(key, checkpoint) {
  await chrome.storage.local.set({ [key]: checkpoint });
  writeCheckpoints.set(key, checkpoint);
}

function renderRepeat(step, inputs, mount) {
  const repeat = step.repeat;
  const bound = workflowInputs({ inputs: { items: repeat.items } }, results);
  const items = writeItems(bound.items, repeat);
  const readFields = fieldsFor(step, mount);
  const key = journalKey(step);
  const stored = writeCheckpoints.get(key);
  if (stored && (stored.runId !== workflowRunId || stored.status.length !== items.length)) {
    mount.append(node('p', 'A previous item session has a checkpoint. Restore its saved results to resume, or check the destination before starting a new session.'));
    mount.append(details('Previous checkpoint', node('pre', preview(checkpointSummary(stored)))));
    mount.append(button('replace-checkpoint', 'Start a new item session', () => {
      if (!confirm('Start a new item session after checking the destination for earlier writes?')) return;
      void act('Starting a new item session…', async () => {
        await lockedCheckpoint(key, async current => {
          if (!current || JSON.stringify(current) !== JSON.stringify(stored)) throw new Error('The write checkpoint changed. Refresh before continuing.');
          await persistCheckpoint(key, newCheckpoint(workflowRunId, items.length));
        });
        render();
      });
    }));
    return;
  }

  const checkpoint = stored ?? newCheckpoint(workflowRunId, items.length);
  const position = currentItem(checkpoint);
  mount.append(details('Item progress', node('pre', preview(checkpointSummary(checkpoint)))));
  if (position === -1) {
    mount.append(node('p', items.length ? 'Every item has been resolved.' : 'There are no items to write.'));
    mount.append(button('finish-items', 'Complete this step', () => void act('Completing the item session…', async () => {
      saveStep(step, checkpointSummary(checkpoint));
      return afterStep();
    }), true));
    return;
  }

  const item = items[position];
  const status = checkpoint.status[position];
  const mapped = repeat.map ? mapItemInputs(repeat.map, item.raw, position) : { [repeat.input]: item.value };
  const inputsForItem = { ...inputs, ...mapped };
  mount.append(node('p', `Item ${position + 1} of ${items.length} · ${item.label}`));
  mount.append(details('Review item inputs', node('pre', preview(inputsForItem))));

  async function change(action, work) {
    return await lockedCheckpoint(key, async storedNow => {
      const current = storedNow ?? newCheckpoint(workflowRunId, items.length);
      if (JSON.stringify(current) !== JSON.stringify(checkpoint)) throw new Error('The write checkpoint changed. Refresh before continuing.');
      const next = await work?.(current) ?? updateCheckpoint(current, position, action);
      await persistCheckpoint(key, next);
      render();
      return next;
    });
  }

  if (canWrite(status)) {
    mount.append(button('write-item', 'Run this item', () => void act('Writing the selected item…', async () => {
      const fields = readFields();
      return await lockedCheckpoint(key, async storedNow => {
        const current = storedNow ?? newCheckpoint(workflowRunId, items.length);
        if (JSON.stringify(current) !== JSON.stringify(checkpoint)) throw new Error('The write checkpoint changed. Refresh before continuing.');
        const uncertain = updateCheckpoint(current, position, 'begin');
        await persistCheckpoint(key, uncertain);
        rolesLocked = true;
        try {
          const result = await executeRecipe(step, inputsForItem, fields);
          await persistCheckpoint(key, updateCheckpoint(uncertain, position, 'confirm'));
          void appendHistory(step, 'Item complete', result.runId).catch(() => {});
          return 'This item completed. Review the next item.';
        } catch (error) {
          throw new Error(`Check the destination before retrying. ${error.message}`);
        } finally {
          render();
        }
      });
    }, true), true));
  } else {
    mount.append(node('p', 'The write may have taken effect. Check the destination before retrying.'));
    if (repeat.verify) {
      mount.append(button('verify-item', 'Recheck this item', () => void act('Rechecking the selected item…', async () => {
        await change('confirm', async current => {
          const { input, map, output, equals, recipeId } = repeat.verify;
          const bindings = map ? mapItemInputs(map, item.raw, position) : input ? { [input]: item.value } : {};
          const verification = await executeRecipe(step, bindings, {}, recipeId);
          if (!Object.is(verification.outputs[output], equals)) throw new Error('The recheck did not confirm the write. Check the destination directly.');
          return updateCheckpoint(current, position, 'confirm');
        });
        return 'The destination confirmed the item.';
      })));
    }
    mount.append(button('mark-applied', 'Mark applied', () => void act('Recording the checked result…', async () => {
      await change('confirm');
      return 'Item marked applied.';
    })));
    mount.append(button('mark-not-applied', 'Mark not applied', () => void act('Recording the checked result…', async () => {
      await change('missing');
      return 'Item marked not applied. Run this item to make a new attempt.';
    })));
  }
  mount.append(button('skip-item', 'Skip this item', () => void act('Skipping the item…', async () => {
    await change('skip');
    return 'Item skipped.';
  })));
}

function renderRecipe(step, inputs, mount) {
  const tabId = selectedTabs.get(step.tab);
  const role = workflow.tabs[step.tab];
  mount.append(node('p', `${role.label} · tab ${tabId}`));
  if (step.repeat) {
    renderRepeat(step, inputs, mount);
    return;
  }
  if (Object.keys(inputs).length) mount.append(details('Review recipe inputs', node('pre', preview(inputs))));
  const readFields = fieldsFor(step, mount);
  mount.append(button('execute-step', step.effect === 'write' ? step.label : 'Run this step', () => {
    void act(`Running ${step.label}…`, async () => {
      await runRecipe(step, inputs, readFields());
      return afterStep();
    }, true);
  }, true));
}

function renderConnector(step, inputs, mount) {
  const readFields = fieldsFor(step, mount);
  mount.append(node('p', `Configured source · ${step.connector}`));
  if (Object.keys(inputs).length) mount.append(details('Review request inputs', node('pre', preview(inputs))));
  mount.append(button('execute-step', step.label, () => {
    void act(`Reading ${step.label}…`, async () => {
      const fields = readFields();
      saveStep(step, await runConnector(step, { ...inputs, ...fields }), fields);
      return afterStep();
    }, true);
  }, true));
}

function renderTransform(step, inputs, mount) {
  const readFields = fieldsFor(step, mount);
  const selection = node('div', undefined, { id: 'selection', hidden: '' });
  const run = button('execute-step', step.select ? 'Prepare review' : 'Run this step', () => {
    void act(`Running ${step.label}…`, async () => {
      const fields = readFields();
      const value = await executeTransform(step, inputs, fields);
      if (!step.select) {
        saveStep(step, value, fields);
        return afterStep();
      }
      selectionEvents.abort();
      selectionEvents = new AbortController();
      selection.replaceChildren();
      selection.hidden = false;
      const choices = [];
      const items = value.items ?? [];
      selection.append(node('h4', 'Review proposed items'));
      for (const [position, item] of items.entries()) {
        const checkbox = node('input', undefined, { type: 'checkbox', value: position });
        const label = node('label', undefined, { class: 'selection-option' });
        label.append(checkbox, document.createTextNode(` ${item.label}`));
        selection.append(label);
        choices.push(checkbox);
      }
      if (!items.length) selection.append(node('p', 'There are no items to select.'));
      if (value.details !== undefined) selection.append(details('Review details', node('pre', preview(value.details))));
      const apply = button('apply-selection', 'Use selected items', () => {
        void act('Saving selection…', async () => {
          saveStep(step, value, fields, choices.flatMap((choice, position) => choice.checked ? [items[position].value] : []));
          return afterStep();
        });
      }, true);
      apply.disabled = choices.length > 0;
      selection.addEventListener('change', () => {
        apply.disabled = !choices.some(choice => choice.checked);
      }, { signal: selectionEvents.signal });
      selection.append(apply);
      return 'Review the proposed items before continuing.';
    }, true);
  }, true);
  let selectionEvents = new AbortController();
  mount.addEventListener('input', event => {
    if (!selection.contains(event.target)) {
      selection.hidden = true;
      selectionEvents.abort();
      selectionEvents = new AbortController();
    }
  });
  mount.append(run, selection);
}

function parseReply(text) {
  try {
    return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
  } catch {
    throw new Error('Paste a valid JSON reply.');
  }
}

function renderModel() {
  const available = models.length > 0;
  for (const id of ['guide-model', 'model']) {
    const picker = el(id);
    if (!picker) continue;
    picker.replaceChildren();
    for (const entry of models) picker.append(new Option(entry.name || entry.id, entry.id));
    if (models.some(entry => entry.id === chosenModel)) picker.value = chosenModel;
    picker.disabled = !available;
  }
  el('ask-guide').disabled = busy || !available;
  if (el('compare')) {
    el('compare').disabled = !available;
    el('model-help').textContent = available
      ? 'Review the data before sending it to ChatGPT.'
      : 'Sign in with ChatGPT to send the reviewed data.';
  }
}

function renderAgent(step, inputs, mount) {
  mount.append(node('p', 'Review the data and remove anything you do not want to share.'));
  const documents = agentDocumentInputs(inputs);
  const selectedAttachments = new Set();
  const reviewed = node('textarea', undefined, { rows: 7, spellcheck: 'false' });
  reviewed.value = JSON.stringify(documents.inputs, null, 2);
  mount.append(field('review-inputs', 'Data to send (JSON)', reviewed));
  if (documents.attachments.length) {
    const files = node('div', undefined, { id: 'agent-attachments' });
    files.append(node('h4', 'Attachments to share'));
    for (const [index, document] of documents.attachments.entries()) {
      const checkbox = node('input', undefined, { type: 'checkbox' });
      const label = node('label', undefined, { class: 'selection-option' });
      label.append(checkbox, globalThis.document.createTextNode(` ${document.name} (${document.mimeType})`));
      checkbox.addEventListener('input', () => {
        if (checkbox.checked) selectedAttachments.add(index + 1);
        else selectedAttachments.delete(index + 1);
      });
      files.append(label, button(`download-agent-file-${index}`, 'Download for manual handoff', () => {
        const bytes = Uint8Array.from(atob(document.base64), character => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: document.mimeType }));
        node('a', undefined, { href: url, download: document.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }));
    }
    mount.append(files);
  }
  mount.append(details('Review workflow instructions', node('pre', step.instruction)));
  const instructionKey = `workflow-instructions-${workflow.id}-${step.id}`;
  const guidance = node('textarea', undefined, { rows: 3, maxlength: '500' });
  mount.append(field('instructions', 'Additional instructions (optional)', guidance));
  let guidanceEdited = false;
  guidance.addEventListener('input', () => { guidanceEdited = true; });
  void chrome.storage.local.get(instructionKey).then(record => {
    if (!guidanceEdited && guidance.isConnected) guidance.value = record[instructionKey] ?? '';
  }).catch(() => {});
  const remember = button('remember-instructions', 'Save instructions as a default', () => {
    void act('Saving instructions…', async () => {
      if (guidance.value.trim()) await chrome.storage.local.set({ [instructionKey]: guidance.value.trim() });
      else await chrome.storage.local.remove(instructionKey);
      return guidance.value.trim() ? 'Instructions saved for this workflow step.' : 'Saved instructions cleared.';
    });
  });
  mount.append(remember);
  const readFields = fieldsFor(step, mount);
  const prompt = node('textarea', undefined, { rows: 6, readonly: '' });
  const reply = node('textarea', undefined, { rows: 5, spellcheck: 'false' });
  let prepared;
  function currentRequest() {
    let data;
    try {
      data = JSON.parse(reviewed.value);
    } catch {
      throw new Error('Enter valid JSON in the data to send.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The data to send must be a JSON object.');
    const fields = readFields();
    const reviewedFiles = reviewedDocumentInputs(data, documents.attachments, selectedAttachments);
    const base = workflowPrompt(step, reviewedFiles.inputs, fields);
    const extra = guidance.value.trim();
    return {
      prompt: extra ? `${base}

Additional user instructions (respect the output requirements above):
${extra}` : base,
      fields,
      attachments: reviewedFiles.attachments,
    };
  }
  function finish(text, requestData, sent) {
    saveStep(step, parseReply(text), requestData.fields, [], { prompt: requestData.prompt, sent });
    return afterStep();
  }
  const mode = node('select');
  mode.append(new Option('Sign in with ChatGPT', 'chatgpt'), new Option('Manual chat handoff', 'manual'));
  mount.append(field('agent-mode', 'Agent response mode', mode));
  const model = node('select');
  model.addEventListener('change', () => { chosenModel = model.value; renderModel(); });
  const online = node('div');
  online.append(field('model', 'Model', model), node('p', undefined, { id: 'model-help' }));
  online.append(button('compare', 'Send to ChatGPT', () => {
    void act('Waiting for ChatGPT…', async () => {
      await allowModelShare(step);
      const requestData = currentRequest();
      chosenModel = model.value;
      const { text } = await request('plan', {
        model: model.value, prompt: requestData.prompt,
        ...(requestData.attachments.length ? { attachments: requestData.attachments } : {}),
      }, true);
      return finish(text, requestData, true);
    }, true);
  }, true));

  const desktop = node('div', undefined, { hidden: '' });
  desktop.append(
    node('p', 'Prepare the prompt, copy it into your chat, and paste the JSON reply here.'),
    button('prepare', 'Prepare prompt', () => {
      void act('Preparing the prompt…', async () => {
        await allowModelShare(step);
        prepared = currentRequest();
        prompt.value = prepared.prompt;
        reply.value = '';
        prompt.select();
        return prepared.attachments.length
          ? 'Copy the prompt and attach the selected files in the same order in your chat.'
          : 'Copy the prompt into your desktop chat.';
      });
    }),
    field('prompt', 'Prompt to copy', prompt),
    field('reply', 'Reply from your chat', reply),
    button('use-reply', 'Review reply', () => {
      void act('Reading the reply…', async () => {
        const current = currentRequest();
        if (!prepared || current.prompt !== prepared.prompt) throw new Error('Prepare a fresh prompt before using a reply.');
        return finish(reply.value, current, false);
      });
    }),
  );
  mount.addEventListener('input', event => {
    if (event.target.matches('#review-inputs, #instructions, [id^="field-"], #agent-attachments input')) {
      prepared = undefined;
      prompt.value = '';
      reply.value = '';
    }
  });
  mode.addEventListener('change', () => {
    online.hidden = mode.value !== 'chatgpt';
    desktop.hidden = mode.value !== 'manual';
  });
  mount.append(online, desktop);
}

function render() {
  el('execution').hidden = !workflow;
  el('description').textContent = workflow?.description ?? '';
  el('description').hidden = !workflow?.description;
  renderRoles();
  if (!workflow) {
    updateControls();
    return;
  }
  renderSteps();
  const root = el('current');
  root.replaceChildren();
  el('reset').hidden = index === 0;
  el('save-results').hidden = index === 0;
  const step = workflow.steps[index];
  if (!step) {
    root.append(node('p', 'All workflow steps are complete.', { tabindex: '-1' }));
    updateControls();
    return;
  }
  if (!roleSelected()) {
    root.append(node('p', restored ? 'Select the tabs to use before resuming the saved workflow.' : 'Choose an approved tab for each role before running the workflow.'));
    updateControls();
    return;
  }
  const group = node('fieldset');
  group.append(node('h3', step.label, { tabindex: '-1' }));
  if (step.description) group.append(node('p', step.description));
  try {
    const inputs = workflowInputs(step, results);
    if (canAdvance(step)) {
      group.append(button('advance', 'Run to next review', () => void act('Running workflow…', advance, true), true));
    }
    if (step.op === 'recipe') renderRecipe(step, inputs, group);
    else if (step.op === 'transform') renderTransform(step, inputs, group);
    else if (step.op === 'connector') renderConnector(step, inputs, group);
    else if (step.op === 'agent') renderAgent(step, inputs, group);
  } catch (error) {
    group.append(node('p', error.message));
  }
  root.append(group);
  renderModel();
  updateControls();
}

function selectWorkflow() {
  el('workflow-failure').hidden = true;
  el('workflow-failure-log').value = '';
  resetGuide();
  workflow = workflows.find(item => item.id === el('workflow').value);
  workflowRunId = crypto.randomUUID();
  results.clear();
  selectedTabs.clear();
  index = 0;
  rolesLocked = false;
  restored = false;
  render();
  report();
}

async function refresh() {
  const [data, installed, checkpoints] = await Promise.all([request('runner.list'), getWorkflows(), records(checkpointPrefix)]);
  const activeRepeat = workflow?.steps[index]?.repeat ? journalKey(workflow.steps[index]) : undefined;
  const before = activeRepeat ? writeCheckpoints.get(activeRepeat) : undefined;
  writeCheckpoints.clear();
  for (const [key, checkpoint] of checkpoints) writeCheckpoints.set(key, checkpoint);
  const checkpointChanged = activeRepeat && JSON.stringify(before) !== JSON.stringify(writeCheckpoints.get(activeRepeat));
  tabs = data.tabs;
  renderDevTabs(data.catalog);
  workflows = installed;
  const previous = workflow?.id;
  el('workflow').replaceChildren(new Option('Choose a workflow', ''));
  for (const definition of workflows) el('workflow').append(new Option(definition.title, definition.id));
  if (workflows.some(definition => definition.id === previous)) {
    el('workflow').value = previous;
    const next = workflows.find(definition => definition.id === previous);
    if (JSON.stringify(next) !== JSON.stringify(workflow)) {
      selectWorkflow();
      return 'The workflow changed. Choose its tabs again.';
    }
    workflow = next;
    renderRoles();
    if (checkpointChanged || !el('current').querySelector('fieldset') || !roleSelected()) render();
  } else {
    selectWorkflow();
  }
  return workflows.length ? '' : 'Install a workflow catalog in Settings, then refresh.';
}

async function setAccount(state) {
  connected = state.connected === true;
  models = [];
  el('account').textContent = connected
    ? `Connected to ChatGPT${state.email ? ` as ${state.email}` : ''}`
    : 'Disconnected';
  el('signin').hidden = connected;
  el('signout').hidden = !connected;
  renderModel();
  if (connected) {
    ({ models } = await request('models', {}, true));
    renderModel();
  }
}

const guideTargets = {
  'choose-tab': '#roles select:not(:disabled)',
  advance: '#advance',
  'review-data': '#review-inputs',
  'review-write': '#current h3',
  'review-step': '#current h3',
};

function clearGuideRequest() {
  pendingGuide = undefined;
  el('guide-request').hidden = true;
  el('guide-prompt').value = '';
  el('guide-reply').value = '';
}

function resetGuide() {
  clearGuideRequest();
  guideConversation.length = 0;
  el('guide-conversation').replaceChildren();
  el('guide-question').value = '';
}

function guideState() {
  const step = workflow.steps[index];
  return {
    workflow: workflow.title,
    step: step?.label ?? null,
    stepId: step?.id ?? null,
    runId: workflowRunId,
    tabs: [...selectedTabs],
    actions: availableGuideActions(step, roleSelected(), canAdvance(step))
      .filter(action => document.querySelector(guideTargets[action.id])),
  };
}

function currentGuide() {
  if (!pendingGuide || pendingGuide.signature !== JSON.stringify(guideState())) {
    throw new Error('Review a fresh Guide payload for the current step.');
  }
  return pendingGuide;
}

function handleGuideReply(text, draft) {
  const reply = guideReply(parseReply(text), draft.actions, workflow.steps[index]?.op === 'agent');
  guideConversation.push({ question: draft.question, answer: reply.answer });
  if (guideConversation.length > 12) guideConversation.shift();
  const item = node('li');
  item.append(node('strong', draft.question), node('p', reply.answer));
  item.append(details('Exact prompt for this answer', node('pre', draft.prompt)));
  for (const action of reply.actions) {
    item.append(button('guide-action-' + crypto.randomUUID(), action.label, () => {
      if (!guideState().actions.some(current => current.id === action.id)) return;
      document.querySelector(guideTargets[action.id])?.focus();
    }));
  }
  for (const instruction of reply.instructions) {
    item.append(button('guide-instruction-' + crypto.randomUUID(), 'Use suggestion · ' + instruction, () => {
      if (workflowRunId !== draft.runId || workflow.steps[index]?.id !== draft.stepId) return;
      const input = el('instructions');
      if (!input) return;
      input.value = [input.value, instruction].filter(Boolean).join('\n').slice(0, input.maxLength);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }));
  }
  if (el('guide-conversation').childElementCount === 12) el('guide-conversation').firstElementChild.remove();
  el('guide-conversation').append(item);
  el('guide-question').value = '';
  clearGuideRequest();
  return 'Guide reply ready.';
}

el('guide-model').addEventListener('change', event => { chosenModel = event.target.value; renderModel(); });
el('guide-mode').addEventListener('change', event => {
  el('guide-online').hidden = event.target.value !== 'chatgpt';
  el('guide-manual').hidden = event.target.value !== 'manual';
});
el('guide-question').addEventListener('input', clearGuideRequest);
el('prepare-guide').addEventListener('click', () => void act('Preparing the Guide payload…', async () => {
  const state = guideState();
  const question = el('guide-question').value.trim();
  const prompt = guidePrompt({ ...state, question, history: guideConversation });
  pendingGuide = { question, prompt, actions: state.actions, stepId: state.stepId, runId: state.runId, signature: JSON.stringify(state) };
  el('guide-prompt').value = prompt;
  el('guide-request').hidden = false;
  return 'Review the exact payload before sending or copying it.';
}));
el('ask-guide').addEventListener('click', () => void act('Waiting for the Guide…', async () => {
  const draft = currentGuide();
  const model = el('guide-model').value;
  if (!model) throw new Error('Sign in with ChatGPT before sending the Guide question.');
  const { text } = await request('plan', { model, prompt: draft.prompt }, true);
  return handleGuideReply(text, draft);
}));
el('use-guide-reply').addEventListener('click', () => void act('Reading the Guide reply…', async () =>
  handleGuideReply(el('guide-reply').value, currentGuide())));

async function records(prefix) {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([key]) => key.startsWith(prefix))
    .sort(([, left], [, right]) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''));
}

async function appendHistory(step, status, runId) {
  const key = historyPrefix + crypto.randomUUID();
  await chrome.storage.local.set({
    [key]: {
      workflowId: workflow.id, title: workflow.title, stepId: step.id, label: step.label, status,
      timestamp: new Date().toISOString(), ...(runId ? { runId } : {}),
    },
  });
  const previous = await records(historyPrefix);
  if (previous.length > 50) await chrome.storage.local.remove(previous.slice(50).map(([id]) => id));
  if (el('history').open) await showHistory();
}

function restore(snapshot) {
  const installed = workflows.find(item => item.id === snapshot.workflowId);
  if (!installed || JSON.stringify(installed) !== snapshot.definition) {
    throw new Error('Install the saved workflow version before restoring its results.');
  }
  el('workflow').value = installed.id;
  selectWorkflow();
  workflowRunId = snapshot.runId ?? crypto.randomUUID();
  for (const [id, entry] of snapshot.results) results.set(id, entry);
  index = results.size;
  restored = true;
  render();
  return 'Saved results restored.';
}

async function showHistory() {
  const [activity, snapshots] = await Promise.all([records(historyPrefix), records(savedPrefix)]);
  const target = el('history-items');
  target.replaceChildren();
  if (!activity.length && !snapshots.length) target.append(node('p', 'No workflow activity yet.'));
  for (const [key, entry] of snapshots) {
    const item = node('article');
    item.append(node('strong', entry.title), node('p', `Saved ${new Date(entry.timestamp).toLocaleString()}`));
    item.append(button(`restore-${key}`, 'Restore saved results', () => {
      void act('Restoring workflow results…', async () => restore(entry));
    }));
    item.append(button(`remove-${key}`, 'Remove saved results', () => {
      if (!confirm('Remove these saved results from this browser?')) return;
      void act('Removing saved results…', async () => {
        await chrome.storage.local.remove(key);
        await showHistory();
        return 'Saved results removed.';
      });
    }));
    target.append(item);
  }
  if (activity.length) {
    const list = node('ol');
    for (const [, entry] of activity) {
      const time = new Date(entry.timestamp).toLocaleString();
      list.append(node('li', `${time} · ${entry.title} · ${entry.label} · ${entry.status}${entry.runId ? ` · run ${entry.runId}` : ''}`));
    }
    target.append(list);
  }
  updateControls();
}

function renderDevTabs(catalog) {
  const picker = el('dev-tab');
  const previous = picker.value;
  picker.replaceChildren(new Option('Choose a tab and adapter', ''));
  for (const tab of tabs) {
    for (const adapterId of tab.adapterIds) {
      const adapter = catalog.find(item => item.id === adapterId);
      if (adapter) picker.append(new Option(`${tab.title || 'Untitled tab'} · ${adapter.title} · tab ${tab.tabId}`, `${tab.tabId}/${adapterId}`));
    }
  }
  if ([...picker.options].some(option => option.value === previous)) picker.value = previous;
}

function devArgs() {
  const choice = el('dev-tab').value;
  if (!choice) throw new Error('Choose an approved tab and adapter.');
  const [tabId, adapterId] = choice.split('/');
  return { tabId: Number(tabId), adapterId };
}

function showDeveloperOutput(value) {
  el('developer-result').textContent = preview(value);
}

el('history').addEventListener('toggle', () => {
  if (el('history').open) void showHistory().catch(error => report(error.message, true));
});
el('refresh-history').addEventListener('click', () => void act('Loading history…', showHistory));
el('clear-history').addEventListener('click', () => {
  if (!confirm('Clear workflow history and saved results from this browser?')) return;
  void act('Clearing history…', async () => {
    const entries = [...await records(historyPrefix), ...await records(savedPrefix)];
    if (entries.length) await chrome.storage.local.remove(entries.map(([key]) => key));
    await showHistory();
    return 'Workflow history cleared.';
  });
});
el('save-results').addEventListener('click', () => {
  if (!confirm('Save these workflow results on this device? They may contain private data.')) return;
  void act('Saving results…', async () => {
    const snapshot = {
      workflowId: workflow.id,
      title: workflow.title,
      definition: JSON.stringify(workflow),
      runId: workflowRunId,
      results: [...results],
      timestamp: new Date().toISOString(),
    };
    try {
      await chrome.storage.local.set({ [savedPrefix + workflow.id]: snapshot });
    } catch {
      throw new Error('Could not save these results. The result may exceed the browser storage limit.');
    }
    if (el('history').open) await showHistory();
    return 'Results saved on this device.';
  });
});
el('inspect').addEventListener('click', () => void act('Inspecting the selected tab…', async () => {
  const selection = devArgs();
  const result = await request('dev.inspect', selection);
  inspected = { ...selection, note: el('dev-note').value.trim(), result };
  showDeveloperOutput(inspected);
}));
el('dev-tab').addEventListener('change', () => {
  inspected = undefined;
  showDeveloperOutput();
  updateControls();
});
el('download-inspection').addEventListener('click', () => {
  if (!inspected) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(inspected, null, 2)], { type: 'application/json' }));
  const link = node('a', undefined, { href: url, download: `${inspected.adapterId}-inspection.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
el('record-start').addEventListener('click', () => void act('Starting recording…', async () => {
  const selection = devArgs();
  const result = await request('dev.record.start', selection);
  recording = selection;
  el('recording-state').textContent = `Recording up to ${result.maxActions} actions in tab ${selection.tabId}. Switch to that tab and perform the task, then return here to stop.`;
}));
el('record-stop').addEventListener('click', () => void act('Stopping recording…', async () => {
  const result = await request('dev.record.stop', recording ?? devArgs());
  recording = undefined;
  el('recording-state').textContent = result.count
    ? `Recorded ${result.count} actions. Review the selectors and supply test inputs before running the draft.`
    : 'No supported actions were recorded.';
  if (result.count) el('draft').value = JSON.stringify({ recipe: result.recipe, inputs: {} }, null, 2);
}));
el('test-draft').addEventListener('click', () => void act('Running the draft on the selected tab…', async () => {
  let draft;
  try {
    draft = JSON.parse(el('draft').value);
  } catch {
    throw new Error('Enter a JSON draft with a recipe and inputs.');
  }
  if (!draft?.recipe) throw new Error('Enter a JSON draft with a recipe and inputs.');
  const result = await request('dev.test', { ...devArgs(), recipe: draft.recipe, inputs: draft.inputs ?? {} });
  showDeveloperOutput(result);
  return 'Draft completed.';
}));
el('failures').addEventListener('click', () => void act('Loading recent failures…', async () => {
  showDeveloperOutput(await request('dev.failures'));
}));
void chrome.storage.local.get('devMode').then(({ devMode }) => { el('developer').hidden = devMode !== true; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.devMode) {
    el('developer').hidden = changes.devMode.newValue !== true;
    if (el('developer').hidden) {
      recording = undefined;
      el('recording-state').textContent = '';
    }
    updateControls();
  }
});

el('workflow').addEventListener('change', selectWorkflow);
el('refresh').addEventListener('click', () => void act('Finding workflows and approved tabs…', refresh));
el('reset').addEventListener('click', () => {
  resetGuide();
  workflowRunId = crypto.randomUUID();
  index = 0;
  rolesLocked = false;
  restored = false;
  results.clear();
  render();
  report();
});
el('signin').addEventListener('click', () => void act('Complete sign-in in the browser window that opens.', async () => {
  await setAccount(await request('signin', {}, true));
}));
el('signout').addEventListener('click', () => void act('Disconnecting…', async () => {
  const state = await request('signout', {}, true);
  await setAccount(state);
  return state.revoked
    ? 'Disconnected from the local helper.'
    : 'Signed out locally. OpenAI did not confirm revocation. Review app access in ChatGPT Settings.';
}));

void act('Finding workflows and approved tabs…', refresh);
void request('status', {}, true).then(setAccount).catch(error => { el('account').textContent = error.message; });
