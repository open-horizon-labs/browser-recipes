// Opt-in live ChatGPT regression. The browser and the page are disposable.
// Only these synthetic rows go to the locally signed-in Browser Recipes agent.
import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {installDefinitions} from './install-library.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(),'live-recipe-edit-'));
const profile = path.join(stage,'profile');
const origin = 'https://calendar.fixture.test';
const recipe = {id:'read-list',title:'Read events',steps:[{op:'readList',selector:'.event',attributes:['aria-label'],as:'events'}]};
const adapter = {id:'fixture',title:'Calendar fixture',origin,recipes:[recipe]};
const workflow = {id:'review-events',title:'Review events',tabs:{source:{label:'Source',adapterId:adapter.id}},
  steps:[{id:'read',label:'Read events',op:'recipe',effect:'read',tab:'source',recipeId:recipe.id},
    {id:'review',label:'Review remaining events',op:'handoff',tags:['review'],inputs:{remaining:'read.events'}}]};
const html = '<main>' + [
  ['Canceled: Design review','Canceled: Design review, 10:00 AM to 10:30 AM, Wednesday, November 11, 2026, By Example Organizer, Free'],
  ['Planning','Cancelled: Planning, Busy'],
  ['Canceled: Retro','Retro, Busy'],
  ['Demo','Demo, Free'],
  ['Budget review','Budget review, Busy'],
].map(([text,label]) => '<div class="event" aria-label="'+label+'">'+text+'</div>').join('') + '</main>';
let browser;
try {
  const extension = path.join(stage,'extension');
  await cp(path.join(root,'dist'),extension,{recursive:true});
  const manifestPath = path.join(extension,'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.host_permissions = [origin+'/*'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,executablePath:process.env.CHROMIUM_PATH,
    args:['--load-extension='+extension,'--disable-extensions-except='+extension]});
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const extensionOrigin = 'chrome-extension://'+new URL(worker.url()).host;
  const host = 'org.openhorizonlabs.browser_recipes_agent';
  await mkdir(path.join(profile,'NativeMessagingHosts'),{recursive:true});
  await writeFile(path.join(profile,'NativeMessagingHosts',host+'.json'),JSON.stringify({name:host,description:'Live edit test',
    path:path.join(root,'bridge/browser-recipes-agent'),type:'stdio',allowed_origins:[extensionOrigin+'/']}));
  // Install the synthetic app with its permissions via the ordinary settings UI.
  const page = await browser.newPage();
  await page.goto(extensionOrigin+'/options.html');
  await installDefinitions(page,{adapters:[adapter],workflows:[workflow]});
  await page.getByRole('button',{name:'Grant access for '+origin}).click();
  await page.getByText('Site access granted.',{exact:true}).waitFor();
  await browser.route(origin+'/**',route => route.fulfill({contentType:'text/html',body:html}));
  const target = await browser.newPage();
  await target.goto(origin);
  await page.goto(extensionOrigin+'/runs.html');
  await page.bringToFront();
  const send = (command,args = {}) => page.evaluate(async request => {
    const response = await chrome.runtime.sendMessage(request);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  },{command,args});
  const [{tabId}] = await send('tabs');
  for (const [instruction,expected] of [
    ['Skip canceled events',['Demo','Budget review']],
    ['Keep only the budget review',['Budget review']],
  ]) {
    const run = await send('runs.start',{kind:'workflow',workflowId:workflow.id,tabs:{source:tabId},reviewRecipes:true});
    assert.equal(run.pending.tag,'edit-outputs');
    await page.goto(extensionOrigin+'/runs.html#'+run.runId);
    const editor = page.locator('.recipe-editor');
    await editor.locator('summary').click();
    await editor.getByLabel('Instructions for these outputs').fill(instruction);
    await editor.getByRole('button',{name:'Review request'}).click();
    const sendEdit = editor.getByRole('button',{name:'Send edit request to ChatGPT'});
    await sendEdit.waitFor({timeout:50000});
    const model = await editor.locator('select').inputValue();
    await sendEdit.click();
    await page.waitForFunction(() => !document.querySelector('.recipe-editor fieldset')?.disabled,null,{timeout:60000});
    const accept = editor.getByRole('button',{name:'Use proposed outputs'});
    assert.ok(await accept.isVisible(),await editor.getByRole('status').innerText());
    await accept.click();
    await page.getByRole('heading',{name:'Review remaining events',exact:true}).first().waitFor();
    const next = await send('runs.get',{runId:run.runId,includeData:true});
    assert.equal(next.pending.tag,'handoff');
    assert.deepEqual(next.context.inputs.remaining.map(row => row.text),expected);
    await send('runs.cancel',{runId:run.runId});
    console.log('PASS '+model+' interpreted "'+instruction+'"; downstream rows: '+expected.join(', '));
  }
} finally { await browser?.close(); await rm(stage,{recursive:true,force:true}); }
