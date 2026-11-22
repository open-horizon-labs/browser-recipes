// Disposable full Chromium extension session. Every fixture origin is intercepted locally.
import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const app = 'https://app.fixture.test';
const provider = 'https://identity.fixture.test';
const adapter = {id:'account-fixture',title:'Account fixture',origin:app,paths:['/app/'],
  auth:{entryPath:'/app/',origins:[provider]},identity:{selector:'#account'},
  recipes:[{id:'read-title',title:'Read title',steps:[{op:'read',selector:'h1',as:'title'}]}]};
const stage = await mkdtemp(path.join(tmpdir(),'run-account-'));
const extension = path.join(stage,'extension');
let browser;
try {
  await cp(new URL('../dist/',import.meta.url),extension,{recursive:true});
  const manifestPath=path.join(extension,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // In this fixture only, allow reading both tab URLs so Chrome exposes the known provider.
  manifest.host_permissions=[app+'/*',provider+'/*'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  browser=await chromium.launchPersistentContext(path.join(stage,'profile'),{
    channel:'chromium',headless:true,executablePath:process.env.CHROMIUM_PATH,
    args:['--load-extension='+extension,'--disable-extensions-except='+extension],
  });
  const worker=browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker',{timeout:15000});
  await worker.evaluate(({adapter,app}) => chrome.storage.local.set({localCatalog:[adapter],approvedOrigins:[app]}),{adapter,app});
  let account='first@example.test';
  await browser.route('https://*.fixture.test/**', route => route.fulfill({contentType:'text/html',
    body:route.request().url().startsWith(app+'/') ? '<header id="account">'+account+'</header><h1>Fixture record</h1>' : '<h1>Fixture sign-in</h1>'}));
  const site=await browser.newPage();
  await site.goto(app+'/app/');
  const tabId=await worker.evaluate(async origin => (await chrome.tabs.query({url:origin+'/*'}))[0].id,app);
  const panel=await browser.newPage();
  await panel.goto('chrome-extension://'+new URL(worker.url()).host+'/runs.html');
  const selectedTab=() => worker.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
  const front=await selectedTab();
  const call=async (command,args) => {
    const reply=await panel.evaluate(message => chrome.runtime.sendMessage(message),{command,args});
    assert.ok(!reply.error, JSON.stringify(reply.error));
    return reply.result;
  };
  const request={kind:'recipe',adapterId:adapter.id,recipeId:'read-title',tabId};
  const first=await call('runs.start',request);
  assert.equal(first.result.title,'Fixture record');
  await site.goto(provider+'/sign-in');
  const pending=await call('runs.start',request);
  assert.equal(pending.pending.tag,'auth');
  const resume=r => call('runs.resume',{runId:pending.runId,actionId:r.pending.id});
  account='other@example.test';
  await site.goto(app+'/app/');
  const wrong=await resume(pending);
  assert.equal(wrong.status,'waiting');
  assert.equal(wrong.pending.tag,'account-review');
  assert.equal(wrong.result,undefined);
  const again=await resume(wrong);
  assert.equal(again.pending.tag,'account-review');
  account='first@example.test';
  await site.reload();
  const done=await resume(again);
  assert.equal(done.runId,pending.runId);
  assert.equal(done.status,'completed');
  assert.equal(done.result.title,'Fixture record');
  assert.equal(await selectedTab(),front);
  console.log('PASS known-provider sign-in, repeated wrong-account pause, same-run resume with original account, foreground preserved.');
} finally {
  await browser?.close();
  await rm(stage,{recursive:true,force:true});
}
