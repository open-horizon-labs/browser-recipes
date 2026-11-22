import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = name => resolve(root, name);
const stage = await mkdtemp(join(tmpdir(), 'recipes-document-test-'));
const site = project('examples/document-review/site');
const listeners = new Map();
for (const path of ['index.html', 'records/lighting.html', 'records/archive.html', 'files/invoice-text.pdf', 'files/invoice-scan.pdf']) {
  listeners.set('/' + path, await readFile(join(site, path)));
}
listeners.set('/', listeners.get('/index.html'));
const server = createServer((request, response) => {
  const body = listeners.get(request.url);
  response.writeHead(body ? 200 : 404, { 'content-type': request.url.endsWith('.pdf') ? 'application/pdf' : 'text/html' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;

async function registerHost(directory, extensionId, key, filename) {
  const script = join(stage, filename);
  await cp(project('integration/fixtures/documents/native_host.py'), script);
  await chmod(script, 0o700);
  await writeFile(join(directory, key + '.json'), JSON.stringify({
    name: key, description: 'Local document fixture', path: script, type: 'stdio',
    allowed_origins: ['chrome-extension://' + extensionId + '/'],
  }));
}

async function events() {
  const log = await readFile(join(stage, 'events.log'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return log.trim().split('\n').filter(Boolean);
}

async function choose(runner, name) {
  await runner.locator('#execute-step').click();
  const checkbox = runner.locator('#selection').getByRole('checkbox', { name });
  await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await runner.locator('#apply-selection').isDisabled(), true);
  await checkbox.check();
  await runner.locator('#apply-selection').click();
}

async function workflow(extensionOrigin, id) {
  const runner = await browser.newPage();
  await runner.goto(extensionOrigin + '/agent.html');
  const select = runner.locator('#workflow');
  await select.locator('option[value="' + id + '"]').waitFor({ state: 'attached' });
  await select.selectOption(id);
  return runner;
}

async function checkReport(runner, expected) {
  await runner.getByRole('heading', { name: 'Check the claimed source quotes' }).waitFor();
  await runner.locator('#execute-step').click();
  await runner.locator('#status').getByText('Workflow complete.', { exact: true }).waitFor();
  const details = runner.locator('summary').filter({ hasText: 'Check the claimed source quotes' });
  if (await details.count()) await details.first().click();
  await runner.getByText(expected, { exact: false }).first().waitFor({ state: 'attached' });
}

async function browserDocument(extensionOrigin, expectedFileName) {
  const page = await browser.newPage();
  await page.goto(origin);
  const runner = await workflow(extensionOrigin, 'review-invoice-fields');
  await runner.locator('#tab-document').selectOption({ index: 1 });
  await runner.locator('#advance').click();
  await choose(runner, /Example Lighting/);
  await runner.locator('#advance').click();
  await choose(runner, expectedFileName);
  await runner.locator('#advance').click();
  await runner.locator('#review-inputs').waitFor();
  return { page, runner };
}

try {
  const extension = join(stage, 'extension');
  await cp(project('dist'), extension, { recursive: true });
  await cp(join(site, 'files/invoice-scan.pdf'), join(stage, 'invoice-scan.pdf'));
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const profile = join(stage, 'profile');
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, executablePath: process.env.CHROMIUM_PATH,
    args: ['--load-extension=' + extension, '--disable-extensions-except=' + extension],
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const extensionOrigin = 'chrome-extension://' + extensionId;
  const hosts = join(profile, 'NativeMessagingHosts');
  await mkdir(hosts, { recursive: true });
  await registerHost(hosts, extensionId, 'org.openhorizonlabs.browser_recipes_agent', 'agent-fixture.py');
  await registerHost(hosts, extensionId, 'org.openhorizonlabs.browser_recipes_source_servicenow', 'source-fixture.py');
  const catalog = JSON.parse(await readFile(project('examples/document-review/catalog.json'), 'utf8'));
  catalog.adapters[0].origin = origin;
  await worker.evaluate(({ catalog, origin }) => chrome.storage.local.set({
    localCatalog: catalog, approvedOrigins: [origin],
  }), { catalog, origin });

  const text = await browserDocument(extensionOrigin, 'Invoice text PDF');
  assert.equal(JSON.parse(await text.runner.locator('#review-inputs').inputValue()).document.kind, 'markdown');
  assert.equal(await text.runner.locator('#agent-attachments input').count(), 0);
  assert.deepEqual(await events(), []);
  await text.runner.locator('#compare').click();
  await checkReport(text.runner, 'verified-text');
  assert.deepEqual(await events(), ['plan:text']);
  await text.page.close();
  await text.runner.close();

  const options = await browser.newPage();
  await options.goto(extensionOrigin + '/options.html');
  await options.locator('#origins summary').filter({ hasText: 'Allowed operations' }).click();
  const originShare = options.getByLabel('Use data from ' + origin + ' in AI prompts');
  await originShare.uncheck();

  const raster = await browserDocument(extensionOrigin, 'Invoice scanned PDF');
  const selected = raster.runner.locator('#agent-attachments input');
  await selected.waitFor();
  assert.equal(await selected.isChecked(), false);
  const descriptor = JSON.parse(await raster.runner.locator('#review-inputs').inputValue()).document;
  assert.equal(descriptor.kind, 'attachment');
  assert.equal(descriptor.base64, undefined);
  await selected.check();
  await raster.runner.locator('#compare').click();
  await raster.runner.locator('#status').getByText(/permission to include data from/).waitFor();
  assert.deepEqual(await events(), ['plan:text']);
  await originShare.check();
  await raster.runner.locator('#compare').click();
  await checkReport(raster.runner, 'review-scan');
  assert.deepEqual(await events(), ['plan:text', 'plan:scan']);
  await raster.runner.close();
  await raster.page.close();

  const omitted = await browserDocument(extensionOrigin, 'Invoice scanned PDF');
  assert.equal(await omitted.runner.locator('#agent-attachments input').isChecked(), false);
  await omitted.runner.locator('#compare').click();
  await checkReport(omitted.runner, 'review-scan');
  assert.deepEqual(await events(), ['plan:text', 'plan:scan', 'plan:omitted']);
  await omitted.runner.close();
  await omitted.page.close();

  const connector = await workflow(extensionOrigin, 'review-configured-invoice');
  const enabled = options.getByLabel('Enable servicenow');
  const share = options.getByLabel('Use data from servicenow in AI prompts');
  assert.equal(await enabled.isChecked(), false);
  assert.equal(await share.isDisabled(), true);
  await connector.getByLabel('Configured source name').fill('fixture-records');
  await connector.locator('#execute-step').click();
  await connector.locator('#status').getByText('Enable the configured local source in Settings first.', { exact: true }).waitFor();
  assert.deepEqual(await events(), ['plan:text', 'plan:scan', 'plan:omitted']);
  await enabled.check();
  assert.equal(await share.isChecked(), false);
  await connector.locator('#execute-step').click();
  await choose(connector, 'Fixture record');
  await connector.locator('#advance').click();
  await connector.getByRole('heading', { name: 'List attachments for the selected record' }).waitFor();
  await connector.locator('#execute-step').click();
  await choose(connector, 'Invoice scan');
  await connector.locator('#advance').click();
  await connector.getByRole('heading', { name: 'Download the selected document' }).waitFor();
  await connector.locator('#execute-step').click();
  await connector.locator('#review-inputs').waitFor();
  await connector.locator('#agent-attachments input').check();
  await connector.locator('#compare').click();
  await connector.locator('#status').getByText(/permission to include source data/).waitFor();
  const before = ['plan:text', 'plan:scan', 'plan:omitted', 'source:records', 'source:attachments', 'source:document'];
  assert.deepEqual(await events(), before);
  await share.check();
  await connector.locator('#compare').click();
  await checkReport(connector, 'review-scan');
  assert.deepEqual(await events(), [...before, 'plan:scan']);
  await enabled.uncheck();
  assert.equal(await share.isDisabled(), true);
  assert.equal(await share.isChecked(), false);
  console.log('PASS document workflows: scoped record/file selection, text and scan reviews, approved attachment bytes, omitted unchecked attachments, and separate connector opt-ins.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(stage, { recursive: true, force: true });
}
