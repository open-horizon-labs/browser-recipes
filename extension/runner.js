import {createRecipePicker} from './recipe-picker.js';
import {renderRecipeOutputs} from './recipe-outputs.js';
import {watchTabs} from './watch-tabs.js';
import {recipeContract} from './schema.js';
import {recipeEditor} from './recipe-edit-ui.js';
import {assertRecipeModelAccess, getWorkflows, getCatalog} from './settings.js';
const form = document.querySelector('#runner');
const controls = document.querySelector('#controls');
const tabPicker = document.querySelector('#tab');
const recipePicker = createRecipePicker(document.querySelector('#recipe-picker'),recipeChanged);
const inputFields = document.querySelector('#inputs');
const setup = document.querySelector('#recipe-setup');
let lastTabSnapshot;
const runButton = document.querySelector('#run');
const status = document.querySelector('#runner-status');
const results = document.querySelector('#results');
const output = document.querySelector('#output');
const evidence = document.querySelector('#evidence');
const capture = document.querySelector('#capture');
const captureOutput = document.querySelector('#capture-output');

let catalog = [];
let tabs = [];
let recipes = [];
let fields = [];
let inputKey;
const downloadUrls = [];
const openApp = 'open-app';

const launchParams = new URLSearchParams(location.search);
let launchRecipe = launchParams.has('adapter') && launchParams.has('recipe')
  ? {adapter:launchParams.get('adapter'), id:launchParams.get('recipe')} : null;

function canQuickRun(recipe) {
  return recipe.effect === 'read' && !Object.values(recipe.inputs).some(input => input.required);
}

function renderQuickReads() {
  const section = document.querySelector('#quick-reads');
  const search = document.querySelector('#find-read');
  const list = document.querySelector('#read-list');
  list.replaceChildren();
  section.hidden = !catalog.some(a => a.recipes.some(canQuickRun));
  const query = search.value.trim().toLowerCase();
  for (const adapter of catalog) {
    for (const recipe of adapter.recipes.filter(canQuickRun)) {
      const title = adapter.title + ' · ' + recipe.title;
      if (!title.toLowerCase().includes(query)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('span');
      name.textContent = recipe.title;
      const app = document.createElement('small');
      app.textContent = adapter.title;
      button.append(name,app);
      button.onclick = () => {
        if (!controls.disabled) void quickRun(adapter.id,recipe.id,recipe.title);
      };
      list.append(button);
    }
  }
  if (!list.childElementCount && query) list.textContent = 'No matching recipes.';
}
document.querySelector('#find-read').addEventListener('input',renderQuickReads);

function choose(message, error = false) {
  status.textContent = message;
  status.toggleAttribute('data-error', error);
}

async function request(command, args) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ command, args });
  } catch {
    throw new Error('The extension could not be reached. Reload this page and try again.');
  }
  if (response?.error) {
    const { message, code, step, runId } = response.error;
    const context = [code, step ? `Step ${step}` : '', runId ? `Run ${runId}` : ''].filter(Boolean).join(' · ');
    throw new Error(`${message} (${context})`, { cause: response.error });
  }
  if (!response || !Object.hasOwn(response, 'result')) throw new Error('The extension returned no result.');
  return response.result;
}

function clearResults() {
  document.querySelector('#failure').hidden = true;
  document.querySelector('#failure textarea').value = '';
  for (const url of downloadUrls.splice(0)) URL.revokeObjectURL(url);
  output.replaceChildren();
  results.hidden = true;
}

function updateInputs() {
  const recipe = recipes.find(item => item.key === recipePicker.value);
  const key = recipe ? JSON.stringify([tabPicker.value, recipe.key, recipe.inputs]) : '';
  runButton.disabled = !recipe || tabPicker.value === openApp;
  document.querySelector('#start-run').disabled = !recipe;
  if (key === inputKey) return;
  inputKey = key;
  fields = [];
  inputFields.replaceChildren();
  if (!recipe) return;

  for (const [name, definition] of Object.entries(recipe.inputs)) {
    const group = document.createElement('div');
    group.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `recipe-input-${name}`;
    label.textContent = definition.required ? name : `${name} (optional)`;
    const attachment = definition.type === 'attachment';
    const control = document.createElement(attachment ? 'input' : 'textarea');
    control.id = label.htmlFor;
    if (attachment) {
      control.type = 'file';
      control.required = definition.required === true;
      const hint = document.createElement('small');
      hint.id = `${control.id}-hint`;
      hint.textContent = 'File limit 384 KiB';
      control.setAttribute('aria-describedby', hint.id);
      group.append(label, control, hint);
    } else {
      control.rows = 3;
      control.maxLength = 16384;
      group.append(label, control);
    }
    fields.push({ name, attachment, control, required: definition.required === true });
    inputFields.append(group);
  }
  if (fields.some(field => !field.attachment)) {
    inputFields.append(recipeEditor({phase:'inputs', key:recipe.key, authorize:() => assertRecipeModelAccess(recipe.adapterId),
      read:() => Object.fromEntries(fields.filter(f => !f.attachment).map(f => [f.name,f.control.value])),
      apply:value => { for (const f of fields.filter(f => !f.attachment)) f.control.value = value[f.name]; }}));
  }

}

function updateRecipes(previous = recipePicker.value, announce = true) {
  const tab = tabs.find(item => String(item.tabId) === tabPicker.value);
  recipes = [];
  for (const adapter of catalog) {
    if ((tabPicker.value !== openApp && !tab?.adapterIds.includes(adapter.id)) || adapter.recipes.length === 0) continue;
    for (const recipe of adapter.recipes) {
      const key = `${adapter.id}/${recipe.id}`;
      recipes.push({ ...recipe, key, adapterId: adapter.id, app: adapter.title });
    }
  }
  recipePicker.update(recipes,previous);
  capture.disabled = !tab;
  updateInputs();
  if (!announce) return;
  if (tabPicker.value === openApp) choose('');
  else if (!tab) choose(tabs.length ? 'Select the tab you want the recipe to use.' : 'Open a tab for a site you’ve allowed.');
  else if (!recipes.length) choose('This tab has no installed recipes.');
  else choose('');
}

let refreshing = false;
async function refresh(initial = false) {
  refreshing = true;
  if (initial) choose('Finding tabs and recipes…');
  try {
    const [availableSites,installed] = await Promise.all([request('runner.list'),getCatalog()]);
    const snapshot = JSON.stringify([availableSites,installed]);
    if (!initial && snapshot === lastTabSnapshot) return;
    lastTabSnapshot = snapshot;
    tabs = availableSites.tabs;
    const approved = new Set(availableSites.catalog.map(a => a.id));
    catalog = installed.filter(a => approved.has(a.id)).map(adapter => ({
      ...adapter,recipes:adapter.recipes.map(recipe => ({...recipe,...recipeContract(recipe)})),
    }));
    const selected = tabPicker.value;
    tabPicker.replaceChildren(new Option('Choose a tab', ''));
    for (const { tabId, title, adapterIds } of tabs) {
      const sites = catalog.filter(adapter => adapterIds.includes(adapter.id)).map(adapter => adapter.origin);
      const origin = sites[0];
      const name = title || origin;
      const label = origin && name !== origin ? `${name} · ${origin}` : name;
      tabPicker.append(new Option(label, String(tabId)));
    }
    if (catalog.length) tabPicker.insertBefore(new Option('Choose automatically',openApp),tabPicker.options[1] ?? null);
    if (selected === openApp || tabs.some(item => String(item.tabId) === selected)) tabPicker.value = selected;
    else if (catalog.length) tabPicker.value = openApp;
    renderQuickReads();
    const available = launchRecipe && catalog.find(a => a.id === launchRecipe.adapter)?.recipes.find(r => r.id === launchRecipe.id);
    if (available) {
      const {adapter,id} = launchRecipe;
      launchRecipe = null;
      setup.open = true;
      tabPicker.value = openApp;
      updateRecipes(adapter + '/' + id);
    } else {
      const changedTab = selected !== tabPicker.value;
      updateRecipes(recipePicker.value, initial || changedTab);
      if (selected && selected !== openApp && changedTab) choose('That tab closed or left the site. The next run will choose a tab automatically.');
    }
    const noAccess = !catalog.length;
    document.querySelector('#first-workflow').hidden = !noAccess;
    setup.hidden = noAccess;
    if (document.querySelector('#quick-reads').hidden) setup.open = true;
    if (noAccess) {
      const installed = await getWorkflows();
      document.querySelector('#installed-workflows').hidden = !installed.length;
      document.querySelector('#first-workflow-title').textContent = installed.length ? 'Choose a workflow' : 'Try a workflow';
      choose((await getCatalog()).length ? 'For an installed recipe, grant its site access in Settings.' : '');
    }
    if (launchRecipe) {
      const adapter = (await getCatalog()).find(a => a.id === launchRecipe.adapter && a.recipes.some(r => r.id === launchRecipe.id));
      choose(adapter ? 'Grant site access for ' + adapter.origin + ' in Settings.'
        : 'This recipe is no longer installed. Open Settings to check the installed library.',true);
    }
  } catch (error) {
    choose(error.message, true);
  } finally {
    refreshing = false;
    if (initial) controls.disabled = false;
  }
}

async function attachmentInput(file, name) {
  if (file.size > 384 * 1024) throw new Error(`${name} exceeds the 384 KiB upload limit.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const characters = [];
  for (let index = 0; index < bytes.length; index += 16384) {
    characters.push(String.fromCharCode(...bytes.subarray(index, index + 16384)));
  }
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
  return { name: file.name, mimeType, base64: btoa(characters.join('')) };
}

async function gatherInputs() {
  const inputs = Object.create(null);
  for (const { name, attachment, control, required } of fields) {
    if (attachment) {
      if (control.files[0]) inputs[name] = await attachmentInput(control.files[0], name);
    } else if (control.value !== '' || required) {
      inputs[name] = control.value;
    }
  }
  return inputs;
}

function renderOutput(outputs) {
  renderRecipeOutputs(outputs,output,downloadUrls);
  results.hidden = !output.childElementCount;
}

async function quickRun(adapterId,recipeId,title) {
  controls.disabled = true;
  clearResults();
  choose('Running ' + title + '…');
  try {
    showRun(await request('recipe.quickRun',{adapterId,recipeId}),title);
  } catch (error) {
    choose(error.message,true);
  } finally {
    controls.disabled = false;
  }
}

function showRun(record, title, retainData = false) {
  const href = 'runs.html#' + encodeURIComponent(record.runId);
  if (record.status === 'waiting' || retainData) {
    location.assign(href);
    return;
  }
  if (record.status === 'failed') {
    choose(record.error.message,true);
  } else {
    renderOutput(record.result ?? {});
    choose(title + ' completed. ');
  }
  const link = document.createElement('a');
  link.href = href;
  link.textContent = 'Inspect run';
  status.append(link);
  if (!results.hidden) results.scrollIntoView({block:'nearest'});
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const recipe = recipes.find(item => item.key === recipePicker.value);
  if (controls.disabled || !tabPicker.value || !recipe) return;
  const tabId = tabPicker.value === openApp ? null : Number(tabPicker.value);
  controls.disabled = true;
  clearResults();
  choose(`Running ${recipe.title}…`);
  try {
    const inputs = await gatherInputs();
    if (event.submitter !== runButton) {
      const retainData = document.querySelector('#retain-results').checked;
      const record = await request('runs.start', { kind: 'recipe', tabId, autoConnect: tabId === null,
        adapterId: recipe.adapterId, recipeId: recipe.id, inputs, retainData,
        reviewRecipes: document.querySelector('#review-shared').checked });
      showRun(record,recipe.title,retainData);
      return;
    }
    const { outputs, runId } = await request('run', { tabId, adapterId: recipe.adapterId, recipeId: recipe.id, inputs });
    function display(value) {
      clearResults();
      renderOutput(value);
      output.append(recipeEditor({phase:'outputs', key:recipe.key, read:() => value,
        authorize:() => assertRecipeModelAccess(recipe.adapterId), apply:display}));
    }
    display(outputs);
    choose(`${recipe.title} completed on tab ${tabId}. `);
    const inspect = document.createElement('a');
    inspect.href = 'runs.html#' + encodeURIComponent(runId);
    inspect.textContent = 'Inspect run';
    status.append(inspect);
  } catch (error) {
    choose(error.message, true);
    if (error.cause?.code) {
      document.querySelector('#failure textarea').value = JSON.stringify(error.cause, null, 2);
      document.querySelector('#failure').hidden = false;
    }
  } finally {
    controls.disabled = false;
  }
});

tabPicker.addEventListener('change', () => {
  clearResults();
  launchRecipe = null;
  updateRecipes();
});
function recipeChanged() {
  launchRecipe = null;
  clearResults();
  choose('');
  updateInputs();
}
watchTabs(refresh, () => refreshing || controls.disabled);
void refresh(true);

async function captureTab() {
  const tab = tabs.find(item => String(item.tabId) === tabPicker.value);
  if (!tab) return;
  const recipe = recipes.find(item => item.key === recipePicker.value);
  capture.disabled = true;
  captureOutput.replaceChildren();
  choose('Capturing the active site tab…');
  try {
    const { dataUrl } = await request('dev.capture', { tabId: tab.tabId, adapterId: recipe?.adapterId ?? tab.adapterIds[0] });
    if (String(tab.tabId) !== tabPicker.value || evidence.hidden) return;
    if (!/^data:image\/jpeg;base64,/.test(dataUrl)) throw new Error('The browser returned an unsupported image.');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'browser-recipe-evidence.jpg';
    link.textContent = 'Download capture';
    captureOutput.append(link);
    choose('Capture ready.');
  } catch (error) {
    choose(error.message, true);
  } finally {
    capture.disabled = !tabPicker.value;
  }
}

capture.addEventListener('click', () => void captureTab());
void chrome.storage.local.get('devMode').then(({ devMode }) => { evidence.hidden = devMode !== true; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.devMode) return;
  evidence.hidden = changes.devMode.newValue !== true;
  if (evidence.hidden) captureOutput.replaceChildren();
});
