// Linux smoke test. Only the isolated fixture origin is pregranted in the test manifest.
import assert from 'node:assert/strict';
import { spawn, execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { verifyAuthoring } from './authoring.mjs';
import { setupCalendar, verifyCalendar } from './calendar.mjs';
import { uploadRecipe, verifyRunner } from './runner.mjs';

const exec = promisify(execCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const workshopDir = path.join(root, 'integration/fixtures/workshop');
const stage = await mkdtemp(path.join(tmpdir(), 'browser-recipes-'));
const fixtureOrigin = 'http://127.0.0.1:8765';
const runtimeDir = path.join(stage, 'runtime');
const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
const profile = path.join(stage, 'profile');
const extension = path.join(stage, 'extension');
const bridge = path.join(root, 'bridge/browser-recipes');
let browser;
let server;
let calendar;
async function call(name, args = {}) {
  const {stdout} = await exec(bridge, [name, JSON.stringify(args)], {env,maxBuffer:16 * 1024 * 1024});
  return JSON.parse(stdout);
}
async function failure(name, args) {
  try { await call(name, args); } catch (error) {
    const body = JSON.parse(error.stdout);
    assert.ok(body.error?.code);
    return body.error;
  }
  throw Error('Expected command to fail: ' + name);
}
try {
  await mkdir(runtimeDir, {mode: 0o700});
  await cp(path.join(root, 'dist'), extension, {recursive:true});
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const fixture = path.join(stage,'demo');
  await cp(path.join(workshopDir,'site'),fixture,{recursive:true});
  // An opaque image payload exercises file fallback across the native message size boundary.
  const imageBytes = Buffer.alloc(1024 * 1024, 0xa5);
  await writeFile(path.join(fixture,'files','scan.png'), imageBytes);
  const workshop = JSON.parse(await readFile(path.join(workshopDir, 'adapter.json')));
  const ticketPage = path.join(fixture,'ticket.html');
  const ticketHtml = await readFile(ticketPage,'utf8');
  await writeFile(ticketPage,ticketHtml.replace('</main>', `
    <a id="scan" href="/files/scan.png">Scan</a>
    <input id="ticket-state" readonly value="Draft">
    <section><label><input type="checkbox">Example Taxi</label></section>
    <section><label><input type="checkbox">Example Hotel</label></section>
    <button type="button" aria-label="Receipt example.pdf"></button>
    </main>`));
  workshop.recipes.push(uploadRecipe, {id:'read-scan',title:'Read test scan',steps:[
    {op:'readAttachment',selector:'#scan',as:'note',allowedPathPrefix:'/files/'}
  ]});
  workshop.recipes.push({
    id: 'select-reviewed-line', title: 'Select the reviewed line',
    inputs: { line: { type: 'string' } },
    steps: [
      { op: 'assertValue', selector: '#ticket-state', value: 'Draft' },
      { op: 'click', selector: 'section input[type=checkbox]', match: { input: 'line', attribute: 'label' } },
      { op: 'readList', selector: 'section input:checked', attributes: ['label'], as: 'selected' },
      { op: 'readList', selector: 'button[aria-label^="Receipt"]', attributes: ['aria-label'], as: 'attachments' },
      { op: 'readValue', selector: '#ticket-state', as: 'state' },
    ],
  });
  const probe = await fetch(fixtureOrigin).catch(() => null);
  assert.equal(probe, null, 'Fixture port already in use');
  server = spawn('python3', ['-m','http.server','8765','--bind','127.0.0.1','--directory',fixture], {stdio:'ignore'});
  browser = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, executablePath:process.env.CHROMIUM_PATH,
    args:['--load-extension='+extension,'--disable-extensions-except='+extension],
    env
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', {timeout:15000});
  const id = new URL(worker.url()).hostname;
  const extensionOrigin = `chrome-extension://${id}`;
  // Native Messaging resolves its user manifest beneath this disposable user-data directory.
  const hosts = path.join(profile,'NativeMessagingHosts');
  await mkdir(hosts, {recursive:true});
  await writeFile(path.join(hosts,'org.openhorizonlabs.tab_recipes.json'),JSON.stringify({
    name:'org.openhorizonlabs.tab_recipes', description:'Test bridge',path:bridge,type:'stdio',
    allowed_origins:['chrome-extension://'+id+'/']
  }));
  calendar = await setupCalendar({extensionId:id, hosts, stage});
  const target = await browser.newPage();
  await target.goto(fixtureOrigin);
  const options = await browser.newPage();
  const optionsPath = manifest.options_page ?? manifest.options_ui.page;
  await options.goto(extensionOrigin+'/'+optionsPath);
  await configure(options, [workshop, ...calendar.adapters]);
  const active = () => worker.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
  await verifyRunner({browser, worker, extensionOrigin, target, active});
  await verifyCalendar({browser, extensionOrigin, calendar, active});
  console.log('PASS browser runner and calendar sync: explicit tab selection, file inputs, native and desktop comparison, staged ICS, no Import clicks.');
  await enableBridge(options);
  const foreground = await browser.newPage();
  await foreground.goto('about:blank');
  await foreground.bringToFront();
  const tab = (await call('tabs')).find(tab => tab.adapterIds.includes('workshop'));
  assert.ok(tab);
  const args = {adapterId:'workshop', tabId:tab.tabId};
  const run = (recipeId, inputs={}) => call('run',{...args,recipeId,inputs});
  assert.ok((await call('catalog')).some(adapter => adapter.id === 'workshop'));
  const focused = await active();
  assert.notEqual(tab.tabId, focused);
  assert.equal((await run('read-ticket')).outputs.title, 'Ticket 42');
  assert.deepEqual((await run('select-reviewed-line',{line:'Example Hotel'})).outputs, {
    selected:[{text:'', attributes:{label:'Example Hotel'}}],
    attachments:[{text:'', attributes:{'aria-label':'Receipt example.pdf'}}],
    state:'Draft',
  });
  assert.equal((await run('save-response',{message:'private smoke value'})).outputs['saved-response'],'private smoke value');
  assert.match((await run('dispatch-note')).outputs.note.markdown,/Dispatch cleared for pickup/);
  const fallback = (await run('read-scan')).outputs.note;
  assert.equal(fallback.kind, 'file');
  assert.deepEqual(Buffer.from(fallback.base64,'base64'),imageBytes);
  await failure('dev.inspect',args);
  await enableDev(options);
  const inspection = await call('dev.inspect',args);
  assert.match(JSON.stringify(inspection),/dispatch/);
  const recipe = {id:'repair', title:'Repair example', steps:[{op:'read',selector:'#missing',as:'title'}]};
  const failed = await failure('dev.test',{...args,recipe,inputs:{}});
  const recent = await call('dev.failures');
  assert.ok(recent.some(entry => entry.runId === failed.runId && entry.recipeId === 'repair' && entry.step === 1));
  assert.ok(!JSON.stringify([recent,failed]).includes('private smoke value'));
  recipe.steps[0] = {op:'read',target:'ticket',as:'title'};
  assert.equal((await call('dev.test',{...args,recipe,inputs:{}})).outputs.title,'Ticket 42');
  await verifyAuthoring({target,call,args});
  assert.equal(await active(), focused);
  console.log('PASS native CLI → inactive tab: catalog import, navigation, verified write, PDF, discovery, failure handoff, draft repair, foreground preserved.');
} finally {
  await browser?.close();
  await calendar?.close();
  server?.kill();
  await rm(stage,{recursive:true,force:true});
}

async function configure(options, adapters) {
  await options.locator('#catalog').fill(JSON.stringify(adapters));
  await options.locator('#save').click();
  await options.getByText('Catalog saved.',{exact:true}).waitFor({timeout:4000});
  for (const { origin } of adapters) {
    await options.getByRole('button',{name:`Grant access for ${origin}`,exact:true}).click();
    await options.getByRole('button',{name:`Revoke access for ${origin}`,exact:true}).waitFor();
  }
}

async function enableBridge(options) {
  await options.locator('#bridge').check();
  await options.waitForFunction(() => document.querySelector('#bridge-status').textContent.match(/^(Bridge open|Connected)$/) &&
    !document.querySelector('#bridge-status').textContent.toLowerCase().includes('disconnected'),null,{timeout:5000});
}
async function enableDev(options) {
  // Programmatic click keeps the test's foreground tab unchanged.
  await options.locator('#dev').evaluate(control => control.click());
  await options.getByText('Developer tools enabled.',{exact:true}).waitFor({timeout:4000});
}
