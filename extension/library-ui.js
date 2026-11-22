import {communityBrowser} from './community.js';
import {bundled} from './settings.js';
import {combined, localDefinitions, mergeDefinitions, removeDefinition, updateDefinitions} from './library.js';
import {originPattern, recipeContract, validateCatalog} from './schema.js';
import {operationOrigins} from './scope.js';
import {unpackCatalog, roleAdapters} from './workflow.js';

const byId = id => document.getElementById(id);
function element(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function details(title) {
  const panel = element('details');
  panel.append(element('summary', title));
  return panel;
}
function incoming(raw, owner, local) {
  if (raw?.origin) return {adapters:[{recipes:[], ...raw}], workflows:[]};
  if (raw?.tabs && raw.steps) return {adapters:[], workflows:[raw]};
  if (raw?.steps) {
    const adapter = local.adapters.find(a => a.id === owner);
    if (!adapter) throw new Error('Choose the installed adapter that owns this recipe.');
    return {adapters:[{...adapter, recipes:[raw]}], workflows:[]};
  }
  return unpackCatalog(raw);
}

export async function initializeLibrary(refreshSettings) {
  const defaults = await bundled;
  const status = byId('library-status'), save = byId('save'), owner = byId('recipe-owner');
  const file = byId('catalog-file'), preview = byId('preview');
  let raw, local, reading = 0;
  function checked(before) {
    const changes = incoming(raw,owner.value,before);
    validateCatalog(changes.adapters);
    if (new Set(changes.workflows.map(w => w.id)).size !== changes.workflows.length) throw new Error('Duplicate workflow ID in file.');
    const next = mergeDefinitions(before,changes);
    combined(defaults,next);
    return {changes,next};
  }
  function review() {
    preview.replaceChildren();
    save.hidden = true;
    if (!raw) return;
    try {
      const {changes} = checked(local);
      const list = element('div');
      const difference = (item, prior) => !prior ? 'Add' : JSON.stringify(item) !== JSON.stringify(prior) ? 'Update' : '';
      for (const {recipes,...a} of changes.adapters) {
        const old = local.adapters.find(entry => entry.id === a.id);
        const {recipes: priorRecipes, ...prior} = old ?? {};
        const change = difference(a,old && prior);
        const edits = [];
        for (const r of recipes) {
          const operation = difference(r,priorRecipes?.find(entry => entry.id === r.id));
          if (operation) edits.push(element('li',operation + ' · ' + r.title + ' · ' + recipeContract(r).effect));
        }
        if (!change && !edits.length) continue;
        const title = [change && change + ' adapter', a.title + ' (' + a.origin + ')', edits.length && edits.length + (edits.length === 1 ? ' recipe change' : ' recipe changes')].filter(Boolean).join(' · ');
        if (edits.length) {
          const group = details(title);
          const rows = element('ul');
          rows.append(...edits);
          group.append(rows);
          list.append(group);
        } else list.append(element('p',title));
      }
      for (const w of changes.workflows) {
        const change = difference(w,local.workflows.find(entry => entry.id === w.id));
        if (change) list.append(element('p',change + ' workflow · ' + w.title));
      }
      const changed = list.childElementCount > 0;
      preview.append(list);
      status.textContent = changed ? 'Review the changes before installing.' : 'Already up to date.';
      save.hidden = !changed;
    } catch (e) { status.textContent = e.message; }
  }
  async function pruneGrants(installed) {
    const {approvedOrigins = []} = await chrome.storage.local.get('approvedOrigins');
    const sites = new Set(installed.adapters.flatMap(operationOrigins));
    const updated = approvedOrigins.filter(origin => sites.has(origin));
    if (updated.length !== approvedOrigins.length) {
      await chrome.storage.local.set({approvedOrigins:updated});
      const retained = new Set(updated.map(originPattern));
      const removed = [...new Set(approvedOrigins.map(originPattern))].filter(pattern => !retained.has(pattern));
      if (removed.length) await chrome.permissions.remove({origins:removed});
    }
  }
  async function commit(change) {
    await updateDefinitions(defaults,change,pruneGrants);
    await render();
    await refreshSettings();
  }
  function removal(panel, kind, item, adapterId) {
    const button = element('button','Remove ' + kind);
    button.type = 'button';
    button.onclick = async () => {
      try {
        const change = before => removeDefinition(before,combined(defaults,before),kind,item.id,adapterId);
        change(local);
        const detail = kind === 'adapter' ? ' and its installed recipes' : '';
        if (!confirm('Remove ' + item.title + detail + '?')) return;
        await commit(change);
        review();
        status.textContent = 'Removed ' + item.title + '.';
      } catch (e) { status.textContent = e.message; }
    };
    panel.append(button);
  }
  async function render() {
    local = await localDefinitions(defaults);
    const all = combined(defaults,local);
    refreshCommunity();
    const adapters = byId('adapter-list'), workflows = byId('workflow-list');
    adapters.replaceChildren(); workflows.replaceChildren();
    const selected = owner.value;
    owner.replaceChildren(new Option('Choose adapter',''), ...local.adapters.map(a => new Option(a.title,a.id)));
    owner.value = selected;
    for (const a of all.adapters) {
      const panel = details(a.title + ' · ' + a.recipes.length + (a.recipes.length === 1 ? ' recipe' : ' recipes'));
      panel.append(element('p',a.origin));
      const editable = local.adapters.some(row => row.id === a.id);
      for (const r of a.recipes) {
        const contract = recipeContract(r);
        const recipe = details(r.title);
        recipe.append(element('p',contract.effect === 'write' ? 'Changes data in the app' : 'Reads from the app'),
          element('p','Inputs: ' + (Object.keys(contract.inputs).join(', ') || 'None')),
          element('p','Outputs: ' + (contract.outputs.join(', ') || 'None')));
        if (editable) removal(recipe,'recipe',r,a.id);
        const row = element('div');
        row.className = 'installed-recipe';
        const url = 'runner.html?' + new URLSearchParams({adapter:a.id,recipe:r.id});
        const ready = contract.effect === 'read' && !Object.values(contract.inputs).some(i => i.required);
        const actions = element('div');
        if (ready) {
          const run = element('button','Run');
          run.type = 'button';
          run.setAttribute('aria-label','Run ' + r.title);
          run.onclick = () => {
            sessionStorage.setItem('launch-read-recipe',a.id + '/' + r.id);
            location.assign(url);
          };
          actions.append(run,document.createTextNode(' '));
        }
        const launch = element('a',ready ? 'Options' : 'Set up run');
        launch.href = url;
        launch.setAttribute('aria-label','Set up ' + r.title);
        actions.append(launch);
        row.append(recipe,actions);
        panel.append(row);
      }
      if (editable) removal(panel,'adapter',a);
      adapters.append(panel);
    }
    if (!all.adapters.length) adapters.append(element('p','Install a recipe from the community catalog.'));
    for (const w of all.workflows) {
      const panel = details(w.title);
      if (w.description) panel.append(element('p',w.description));
      const steps = element('ol');
      for (const step of w.steps) {
        const binding = step.op === 'recipe' ? roleAdapters(w.tabs[step.tab]).map(id => {
          const a = all.adapters.find(row => row.id === id);
          return a.title + ' / ' + a.recipes.find(r => r.id === step.recipeId).title;
        }).join(' or ') : step.op;
        steps.append(element('li',step.label + ' · ' + binding));
      }
      panel.append(steps);
      const launch = element('a','Open workflow');
      launch.href = 'agent.html?workflow=' + encodeURIComponent(w.id);
      panel.append(launch,document.createTextNode(' '));
      if (local.workflows.some(row => row.id === w.id)) removal(panel,'workflow',w);
      workflows.append(panel);
    }
    if (!all.workflows.length) workflows.append(element('p','No workflows installed.'));
  }
  function offerSetup(workflows, anchor) {
    byId('continue-workflow')?.remove();
    if (workflows.length !== 1) return;
    const link = element('a','Set up ' + workflows[0].title);
    link.href = 'agent.html?workflow=' + encodeURIComponent(workflows[0].id);
    link.id = 'continue-workflow';
    anchor.after(link);
  }
  const refreshCommunity = communityBrowser(async selection => {
    await commit(before => mergeDefinitions(before,selection));
    offerSetup(selection.workflows,byId('community-status'));
    if (raw) review();
  }, () => local);
  owner.onchange = review;
  file.onchange = async () => {
    byId('continue-workflow')?.remove();
    const ticket = ++reading;
    raw = undefined;
    preview.replaceChildren(); save.hidden = true;
    byId('owner-field').hidden = true;
    status.textContent = '';
    const selected = file.files[0];
    if (!selected) return;
    try {
      if (selected.size > 2_000_000) throw new Error('Choose a file smaller than 2 MB.');
      const parsed = JSON.parse(await selected.text());
      if (ticket !== reading) return;
      if (!parsed || typeof parsed !== 'object') throw new Error('Choose an adapter, recipe, workflow, or catalog file.');
      raw = parsed;
      const standalone = !!raw.steps && !raw.tabs && !raw.origin;
      byId('owner-field').hidden = !standalone;
      owner.value = '';
      review();
    } catch (e) { if (ticket === reading) status.textContent = e.message; }
  };
  save.onclick = async () => {
    save.disabled = file.disabled = owner.disabled = true;
    try {
      const workflows = checked(local).changes.workflows;
      await commit(before => checked(before).next);
      raw = undefined; file.value = ''; preview.replaceChildren(); save.hidden = true;
      byId('owner-field').hidden = true;
      status.textContent = 'Changes installed.';
      offerSetup(workflows,status);
    } catch (e) { status.textContent = e.message; }
    finally { save.disabled = file.disabled = owner.disabled = false; }
  };
  await render();
  if (new URLSearchParams(location.search).get('browse') === 'workflows') {
    const browse = byId('browse-community');
    browse.focus();
    browse.click();
  }
}
