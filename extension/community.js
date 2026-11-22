import {roleAdapters, validateBundle} from './workflow.js';
import {recipeContract} from './schema.js';

const repo = 'open-horizon-labs/browser-recipes-catalog';
export const communitySource = 'https://github.com/' + repo;
export const catalogUrl = 'https://raw.githubusercontent.com/' + repo + '/main/distribution/catalog.json';

export async function fetchCommunity() {
  const response = await fetch(catalogUrl,{credentials:'omit',redirect:'error',cache:'no-cache',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('The community catalog returned HTTP ' + response.status + '.');
  return validateBundle(await response.json());
}

export function communityItems(catalog) {
  const items = [];
  for (const adapter of catalog.adapters) {
    items.push({kind:'adapter', title:adapter.title, detail:adapter.origin + ' · ' + adapter.recipes.length + ' recipes',
      path:'adapters/'+adapter.id, adapter});
    for (const recipe of adapter.recipes) {
      items.push({kind:'recipe',title:recipe.title, detail:adapter.title + ' · ' + recipeContract(recipe).effect,
        path:'adapters/'+adapter.id+'/recipes/'+recipe.id+'.json', adapter,recipe});
    }
  }
  for (const workflow of [...catalog.workflows].sort((a,b) => (a.onboardingOrder ?? Number.MAX_SAFE_INTEGER) - (b.onboardingOrder ?? Number.MAX_SAFE_INTEGER))) items.push({kind:'workflow',title:workflow.title,
    detail:workflow.description || workflow.steps.length + ' steps',path:'workflows/'+workflow.id+'.json',workflow});
  return items;
}

export function communitySelection(catalog,item) {
  if (item.recipe) return {adapters:[{...item.adapter,recipes:[item.recipe]}], workflows:[]};
  if (item.adapter) return {adapters:[item.adapter], workflows:[]};
  const workflow = item.workflow;
  const required = new Map();
  for (const role of Object.values(workflow.tabs)) {
    for (const id of roleAdapters(role)) required.set(id,new Set());
  }
  for (const step of workflow.steps.filter(s => s.op === 'recipe')) {
    for (const id of roleAdapters(workflow.tabs[step.tab])) {
      required.get(id).add(step.recipeId);
      if (step.repeat?.verify) required.get(id).add(step.repeat.verify.recipeId);
    }
  }
  return {workflows:[workflow],adapters:catalog.adapters.filter(a => required.has(a.id)).map(a =>
    ({...a,recipes:a.recipes.filter(r => required.get(a.id).has(r.id))}))};
}

export function communityBrowser(onSelect, getLocal) {
  const byId = id => document.getElementById(id);
  const browse = byId('browse-community'), controls = byId('community-controls');
  const search = byId('community-search'), kind = byId('community-kind');
  const results = byId('community-results'), status = byId('community-status');
  let catalog, items;
  function render() {
    results.replaceChildren();
    const query = search.value.toLowerCase().trim();
    const matches = items.filter(item => item.kind === kind.value &&
      [item.title,item.detail,item.path].join(' ').toLowerCase().includes(query));
    status.textContent = matches.length ? matches.length + (matches.length === 1 ? ' result' : ' results') : 'No matches. Try another search or definition type.';
    for (const item of matches) {
      const row = document.createElement('li'), text = document.createElement('div');
      const source = document.createElement('a'), info = document.createElement('small');
      source.href = communitySource + (item.kind === 'adapter' ? '/tree/main/' : '/blob/main/') + item.path;
      source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = item.title;
      info.textContent = item.detail;
      text.append(source,info);
      const selection = communitySelection(catalog,item);
      const local = getLocal();
      const identical = (a,b) => JSON.stringify(a) === JSON.stringify(b);
      const installed = selection.adapters.every(({recipes,...metadata}) => {
        const found = local.adapters.find(a => a.id === metadata.id);
        if (!found) return false;
        const {recipes: prior,...old} = found;
        return identical(metadata,old) && recipes.every(r => identical(r,prior.find(p => p.id === r.id)));
      }) && selection.workflows.every(w => identical(w,local.workflows.find(p => p.id === w.id)));
      const button = document.createElement('button');
      button.type = 'button';
      const prior = item.workflow ? local.workflows.find(w => w.id === item.workflow.id)
        : local.adapters.find(a => a.id === item.adapter.id);
      const exists = item.recipe ? prior?.recipes.some(r => r.id === item.recipe.id) : !!prior;
      const verb = exists ? 'Update' : 'Install';
      button.textContent = installed ? 'Installed' : verb;
      button.disabled = installed;
      button.setAttribute('aria-label',installed ? item.title + ' is installed' : verb + ' ' + item.title);
      button.onclick = async () => {
        button.disabled = true;
        try {
          await onSelect(selection);
          status.textContent = (exists ? 'Updated ' : 'Installed ') + item.title + '.';
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        }
      };
      row.append(text,button); results.append(row);
    }
  }
  browse.onclick = async () => {
    browse.disabled = true; status.textContent = 'Loading the community catalog…';
    try {
      catalog = await fetchCommunity();
      items = communityItems(catalog);
      controls.hidden = false;
      browse.textContent = 'Refresh catalog';
      render();
    } catch (error) {
      status.textContent = 'Could not load the community catalog. ' + error.message + ' Try again or install from a file.';
    } finally { browse.disabled = false; }
  };
  search.oninput = kind.onchange = render;
  return () => { if (items) render(); };
}
