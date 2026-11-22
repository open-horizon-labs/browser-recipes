import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {setupWorkflows} from './calendar.mjs';
import {catalogUrl} from '../extension/community.js';

const root = fileURLToPath(new URL('../',import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(),'workflow-onboarding-'));
const profile = path.join(stage,'profile'), extension = path.join(stage,'extension');
let browser, fixtures;
try {
  await cp(path.join(root,'dist'),extension,{recursive:true});
  const manifestPath = path.join(extension,'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,
    executablePath:process.env.CHROMIUM_PATH,args:['--load-extension='+extension,'--disable-extensions-except='+extension]});
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const hosts = path.join(profile,'NativeMessagingHosts');
  await mkdir(hosts,{recursive:true});
  fixtures = await setupWorkflows({extensionId:id,hosts,stage});
  const app = await browser.newPage();
  await app.route(catalogUrl,route => route.fulfill({contentType:'application/json',body:JSON.stringify(fixtures.bundle)}));
  const source = await browser.newPage(),dest = await browser.newPage();
  await source.goto(fixtures.source.origin+'/week'); await dest.goto(fixtures.destination.origin+'/calendar/u/1/r/week');
  await app.bringToFront();
  await app.goto('chrome-extension://'+id+'/runner.html');
  await app.getByRole('link',{name:'Browse workflows'}).click();
  const title = 'Copy Outlook events to Google Calendar';
  await app.getByRole('button',{name:'Review install of '+title}).click();
  await app.getByRole('button',{name:'Install changes'}).click();
  await app.getByRole('link',{name:'Set up '+title}).click();
  await app.locator('#workflow option[value="outlook-to-google-calendar"]').waitFor({state:'attached'});
  assert.equal(await app.locator('#workflow').inputValue(),'outlook-to-google-calendar');
  const start = app.getByRole('button',{name:'Start workflow',exact:true});
  assert.ok(await start.isDisabled());
  for (const origin of [fixtures.source.origin, fixtures.destination.origin]) {
    await app.getByRole('button',{name:'Grant access to '+origin,exact:true}).click();
    await app.getByText('Site access granted.',{exact:true}).waitFor();
  }
  await app.locator('#tab-source').selectOption({index:1});
  await app.locator('#tab-destination').selectOption({index:1});
  await start.click();
  await app.getByLabel('First day shown').fill('2027-02-01');
  await app.getByLabel('Last day shown').fill('2027-02-07');
  for (const label of ['Outlook time zone','Google Calendar time zone']) await app.getByLabel(label).fill('America/New_York');
  await app.getByRole('button',{name:'Continue with these inputs'}).click();
  await app.getByRole('button',{name:'Review model request'}).click();
  const data = app.getByLabel('Data to share (JSON)');
  await data.fill((await data.inputValue()).replaceAll('Workshop','Reviewed workshop'));
  await app.getByRole('option',{name:'Fixture model'}).waitFor({state:'attached'});
  await app.getByRole('button',{name:'Send to ChatGPT'}).click();
  await app.getByText('Review the model reply before continuing.').waitFor();
  await app.getByRole('button',{name:'Use reviewed reply'}).click();
  await app.getByRole('checkbox',{name:/Reviewed workshop/}).waitFor();
  assert.equal(dest.url(),fixtures.destination.origin+'/calendar/u/1/r/week');
  console.log('PASS first-run panel → workflow catalog → installation → site grants → background calendar comparison → event preview.');
} finally { await browser?.close(); await fixtures?.close(); await rm(stage,{recursive:true,force:true}); }
