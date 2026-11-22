import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const stage = await mkdtemp(path.join(tmpdir(),'br-cli-'));
const profile = path.join(stage,'profile');
const extension = path.join(stage,'extension');
const runtime = fileURLToPath(new URL('../dist',import.meta.url));
const cli = process.env.BROWSER_RECIPES_CLI || 'browser-recipes';
const env = {...process.env, HOME:stage, LOCALAPPDATA:stage, XDG_RUNTIME_DIR:stage};
const server = createServer((_request,response) => {
  response.setHeader('content-type','text/html');
  response.end('<h1>Desktop bridge test</h1>');
});
let browser;
try {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  await cp(runtime,extension,{recursive:true});
  const manifestPath = path.join(extension,'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:true,executablePath:process.env.CHROMIUM_PATH,env,
    args:['--load-extension='+extension,'--disable-extensions-except='+extension],
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const call = (...args) => execFileSync(cli,args,{env,encoding:'utf8',timeout:70000}).trim();
  const registration = call('install',id,'--browser','chromium');
  if (process.platform !== 'win32') {
    const hosts = path.join(profile,'NativeMessagingHosts');
    await mkdir(hosts,{recursive:true});
    await cp(registration,path.join(hosts,path.basename(registration)));
  }
  const adapter = {id:'fixture',title:'Fixture',origin,recipes:[
    {id:'title',title:'Read title',steps:[{op:'read',selector:'h1',as:'title'}]},
  ]};
  await worker.evaluate(async adapter => {
    await chrome.storage.local.set({localCatalog:{adapters:[adapter],workflows:[]},approvedOrigins:[adapter.origin],bridgeEnabled:true});
  },adapter);
  const page = await browser.newPage();
  await page.goto(origin);
  const settings = await browser.newPage();
  await settings.goto('chrome-extension://'+id+'/options.html');
  await settings.evaluate(() => chrome.runtime.sendMessage({command:'bridge.refresh'}));
  const deadline = Date.now()+7000;
  let tabs;
  while (Date.now()<deadline) {
    try { tabs = JSON.parse(call('tabs')); break; }
    catch (error) {
      if (!String(error.stderr).includes('Bridge disconnected')) throw error;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
  }
  const tab = tabs?.find(tab => tab.adapterIds.includes('fixture'));
  assert.ok(tab,'The installed host did not connect to Chromium');
  const reply = JSON.parse(call('run',JSON.stringify({adapterId:'fixture',recipeId:'title',tabId:tab.tabId})));
  assert.equal(reply.outputs.title,'Desktop bridge test');
  console.log('PASS '+process.platform+' installed CLI → native host → Chromium → recipe output');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
  await rm(stage,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
