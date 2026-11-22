// All actions use a disposable profile. Seed the storage format shipped before the library.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {catalogUrl} from '../extension/community.js';
import {chooseDefinitions,installDefinitions} from './install-library.mjs';

const dir = await mkdtemp(path.join(tmpdir(),'recipes-library-'));
const extension = fileURLToPath(new URL('../dist',import.meta.url));
const recipe = {id:'headline',title:'Read headline',steps:[{op:'read',selector:'h1',as:'headline'}]};
const adapter = {id:'news',title:'News',origin:'https://news.example',recipes:[recipe]};
const workflow = {id:'digest',title:'Daily digest',tabs:{news:{label:'News',adapterId:'news'}},
  steps:[{id:'read',op:'recipe',effect:'read',label:'Read headline',tab:'news',recipeId:'headline'}]};
let browser;
try {
  browser = await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,
    executablePath:process.env.CHROMIUM_PATH,args:['--load-extension='+extension,'--disable-extensions-except='+extension]});
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  await worker.evaluate(bundle => chrome.storage.local.set({localCatalog:bundle}),{adapters:[adapter], workflows:[workflow]});
  const page = await browser.newPage();
  await page.goto(new URL('/options.html',worker.url()).href);
  const adapterList = page.locator('#adapter-list');
  const workflowList = page.locator('#workflow-list');
  await adapterList.getByText('News · 1 recipe',{exact:true}).click();
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get('localCatalog')),{});
  await workflowList.getByText('Daily digest',{exact:true}).click();
  await workflowList.getByText('Read headline · News / Read headline').waitFor();
  await adapterList.getByText('Read headline',{exact:true}).click();
  await adapterList.getByRole('button',{name:'Remove recipe'}).click();
  await page.getByText(/Used by Daily digest/).waitFor();
  const privateRecipe = {...recipe,id:'private',title:'Private lookup'};
  await chooseDefinitions(page,privateRecipe);
  await page.getByLabel('Adapter for this recipe').selectOption(adapter.id);
  await page.getByRole('button',{name:'Install changes'}).click();
  await page.getByText('Changes installed.',{exact:true}).waitFor();
  await installDefinitions(page,{...adapter,recipes:[{...recipe,title:'Updated headline'}]});
  await page.reload();
  await adapterList.getByText('News · 2 recipes',{exact:true}).click();
  await adapterList.getByText('Private lookup',{exact:true}).waitFor();
  await adapterList.getByText('Updated headline',{exact:true}).waitFor();
  await chooseDefinitions(page,{...workflow,id:'broken',steps:[{...workflow.steps[0],recipeId:'missing'}]});
  await page.getByText(/Unknown recipe or missing effect/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Install changes'}).count(),0);
  await workflowList.getByText('Daily digest',{exact:true}).click();
  page.once('dialog',dialog => dialog.accept());
  await workflowList.getByRole('button',{name:'Remove workflow'}).click();
  await workflowList.getByText('No workflows installed.').waitFor();
  await adapterList.getByText('News · 2 recipes',{exact:true}).click();
  await adapterList.getByText('Private lookup',{exact:true}).click();
  page.once('dialog',dialog => dialog.accept());
  await adapterList.getByRole('button',{name:'Remove recipe'}).click();
  await adapterList.getByText('News · 1 recipe',{exact:true}).waitFor();
  const other = {...adapter,id:'wire',title:'Wire',origin:'https://wire.example',
    recipes:[{...recipe,id:'wire-headline'}, {...recipe,id:'wire-archive',title:'Read archives'}]};
  const combo = {...workflow,id:'wire-digest',title:'Wire digest',tabs:{news:{label:'Wire',adapterId:'wire'}},
    steps:[{...workflow.steps[0],recipeId:'wire-headline'}]};
  let offline = true;
  await page.route(catalogUrl,route => offline ? route.fulfill({status:503}) : route.fulfill({
    contentType:'application/json',body:JSON.stringify({adapters:[other],workflows:[combo]})}));
  await page.getByRole('button',{name:'Browse community catalog'}).click();
  await page.getByText(/Could not load the community catalog/).waitFor();
  offline = false;
  await page.getByRole('button',{name:'Browse community catalog'}).click();
  await page.getByLabel('Search catalog').fill('Wire digest');
  await page.getByRole('button',{name:'Review install of Wire digest'}).click();
  assert.equal(await workflowList.getByText('Wire digest',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Install changes'}).click();
  await adapterList.getByText('Wire · 1 recipe',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Wire digest is installed'}).waitFor();
  await page.getByLabel('Search catalog').fill('');
  await page.getByLabel('Definition type',{exact:true}).selectOption('recipe');
  await page.getByRole('button',{name:'Review install of Read archives'}).click();
  await page.getByRole('button',{name:'Install changes'}).click();
  await adapterList.getByText('Wire · 2 recipes',{exact:true}).waitFor();
  await page.getByLabel('Definition type',{exact:true}).selectOption('adapter');
  await page.getByRole('button',{name:'Wire is installed'}).waitFor();
  await page.getByRole('button',{name:'Grant access for https://wire.example'}).waitFor();
  console.log('PASS community catalog retry, search, dependency preview, individual recipe install and installed status.');
  console.log('PASS library migration, recipe import, private recipe preservation, dependency protection, removal and reload.');
} finally { await browser?.close(); await rm(dir,{recursive:true,force:true}); }
