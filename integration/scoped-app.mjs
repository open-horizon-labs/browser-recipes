// Run separately from the native-host smoke test. Only temporary loopback sites are used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, cp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

async function site(render) {
  const server = createServer((req,res) => {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(render(req.url));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:' + server.address().port, close:() => server.close()};
}
const tmp = await mkdtemp(join(tmpdir(),'br-scoped-'));
const inner = await site(() => '<header aria-label="Account A">Account</header><main>Record 42</main>');
const parent = await site(() => '<iframe src="' + inner.origin + '/embedded/form"></iframe>');
let browser;
try {
  const ext = join(tmp,'extension');
  await cp(new URL('../dist/',import.meta.url),ext,{recursive:true});
  const manifest = JSON.parse(await readFile(join(ext,'manifest.json')));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(ext,'manifest.json'),JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(join(tmp,'profile'),{headless:true,channel:'chromium',
    executablePath:process.env.CHROMIUM_PATH, args:['--disable-extensions-except='+ext,'--load-extension='+ext]});
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const page = await browser.newPage();
  await page.goto(parent.origin+'/launchpad/home');
  const app = {id:'embedded',title:'Framed form',origin:parent.origin,paths:['/launchpad/'],
    frame:{origin:inner.origin,paths:['/embedded/']}, identity:{selector:'header',attribute:'aria-label'},
    recipes:[{id:'record',title:'Read record',steps:[{op:'read',selector:'main',as:'result'}]}]};
  const controls = await browser.newPage();
  await controls.goto(new URL('agent.html',worker.url()).href);
  const send = (command,args) => controls.evaluate(([command,args])=>chrome.runtime.sendMessage({command,args}),[command,args]);
  await worker.evaluate(async ({app,origins}) => chrome.storage.local.set({localCatalog:[app],approvedOrigins:origins}),
    {app,origins:[parent.origin,inner.origin]});
  const [{tabId}] = (await send('tabs')).result;
  const run = () => send('run',{tabId,adapterId:'embedded',recipeId:'record',inputs:{}});
  assert.equal((await run()).result.outputs.result,'Record 42');
  const frame = page.frames().find(f=>f.url().startsWith(inner.origin));
  await frame.locator('header').evaluate(node=>node.setAttribute('aria-label','Account B'));
  assert.equal((await run()).error.code,'ACCOUNT_CHANGED');
  await frame.locator('header').evaluate(node=>node.setAttribute('aria-label','Account A'));
  await page.evaluate(src=>{const f=document.createElement('iframe');f.src=src;document.body.append(f);},inner.origin+'/embedded/duplicate');
  await page.frameLocator('iframe').nth(1).locator('main').waitFor();
  assert.equal((await run()).error.code,'FRAME_UNAVAILABLE');
  await page.goto(parent.origin+'/other/path');
  assert.equal((await run()).error.code,'PATH_NOT_ALLOWED');
  console.log('PASS background launchpad frame, account change, ambiguous target and out-of-scope page.');
} finally {
  await browser?.close();
  parent.close();
  inner.close();
  await rm(tmp,{recursive:true,force:true});
}
