import {recipeEditor} from './recipe-edit-ui.js';
import {assertRecipeModelAccess} from './settings.js';
const form = document.querySelector('#runner');
const controls = document.querySelector('#controls');
const tabPicker = document.querySelector('#tab');
const recipePicker = document.querySelector('#recipe');
const inputFields = document.querySelector('#inputs');
const refreshButton = document.querySelector('#refresh');
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

function updateRecipes() {
  const previous = recipePicker.value;
  const tab = tabs.find(item => String(item.tabId) === tabPicker.value);
  recipePicker.replaceChildren(new Option('Choose a recipe', ''));
  recipes = [];
  for (const adapter of catalog) {
    if ((tabPicker.value !== openApp && !tab?.adapterIds.includes(adapter.id)) || adapter.recipes.length === 0) continue;
    const group = document.createElement('optgroup');
    group.label = adapter.title;
    for (const recipe of adapter.recipes) {
      const key = `${adapter.id}/${recipe.id}`;
      recipes.push({ ...recipe, key, adapterId: adapter.id });
      group.append(new Option(recipe.title, key));
    }
    recipePicker.append(group);
  }
  recipePicker.disabled = !recipes.length;
  capture.disabled = !tab;
  if (recipes.some(recipe => recipe.key === previous)) recipePicker.value = previous;
  updateInputs();
  if (tabPicker.value === openApp) choose('Choose a recipe. The run will pause if you need to open its app or sign in.');
  else if (!tab) choose(tabs.length ? 'Select the tab you want the recipe to use.' : 'No eligible tabs are open. Open a tab for an approved site and refresh.');
  else if (!recipes.length) choose('This tab has no installed recipes.');
  else choose('');
}

async function refresh() {
  controls.disabled = true;
  const selected = tabPicker.value;
  choose('Loading available tabs and recipes…');
  try {
    ({ catalog, tabs } = await request('runner.list'));
    tabPicker.replaceChildren(new Option('Choose a tab', ''));
    for (const { tabId, title, adapterIds } of tabs) {
      const sites = catalog.filter(adapter => adapterIds.includes(adapter.id)).map(adapter => adapter.origin);
      const origin = sites[0];
      const name = title || origin;
      const label = origin && name !== origin ? `${name} — ${origin} (tab ${tabId})` : `${name} (tab ${tabId})`;
      tabPicker.append(new Option(label, String(tabId)));
    }
    if (catalog.length) tabPicker.append(new Option('Find or open the app for my recipe', openApp));
    if (selected === openApp || tabs.some(item => String(item.tabId) === selected)) tabPicker.value = selected;
    else if (!tabs.length && catalog.length) tabPicker.value = openApp;
    updateRecipes();
    if (!catalog.length) choose('Install and grant access to an adapter in Settings, then refresh.');
  } catch (error) {
    choose(error.message, true);
  } finally {
    controls.disabled = false;
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
  for (const [name, value] of Object.entries(outputs)) {
    const heading = document.createElement('h3');
    heading.textContent = name;
    output.append(heading);
    if (value?.kind === 'file') {
      const bytes = Uint8Array.from(atob(value.base64), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
      downloadUrls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = value.name;
      link.textContent = `Download ${value.name}`;
      output.append(link);
    } else {
      const text = document.createElement('pre');
      text.textContent = value?.kind === 'markdown'
        ? value.markdown
        : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      output.append(text);
    }
  }
  results.hidden = !output.childElementCount;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const recipe = recipes.find(item => item.key === recipePicker.value);
  if (controls.disabled || !tabPicker.value || !recipe) return;
  const tabId = tabPicker.value === openApp ? null : Number(tabPicker.value);
  controls.disabled = true;
  clearResults();
  choose(`Running ${recipe.title} on tab ${tabId}…`);
  try {
    const inputs = await gatherInputs();
    if (event.submitter !== runButton) {
      const retainData = document.querySelector('#retain-results').checked;
      const record = await request('runs.start', { kind: 'recipe', tabId, adapterId: recipe.adapterId, recipeId: recipe.id, inputs, retainData,
        reviewRecipes: document.querySelector('#review-shared').checked });
      const href = 'runs.html#' + encodeURIComponent(record.runId);
      if (record.result === undefined || retainData) location.assign(href);
      else {
        renderOutput(record.result);
        choose(`${recipe.title} completed. `);
        const link = document.createElement('a');
        link.href = href;
        link.textContent = 'Inspect run';
        status.append(link);
      }
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
  recipePicker.value = '';
  updateRecipes();
});
recipePicker.addEventListener('change', () => {
  clearResults();
  choose('');
  updateInputs();
});
refreshButton.addEventListener('click', () => void refresh());
void refresh();

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
