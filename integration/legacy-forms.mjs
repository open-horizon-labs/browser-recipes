import {installDefinitions} from './install-library.mjs';
// Uses the prototype's loopback fake app and a new temporary database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const fakeRoot = process.env.FAKE_SAP_ROOT;
assert.ok(fakeRoot, 'Set FAKE_SAP_ROOT to the prototype dev/fake-sap directory.');
const stage = await mkdtemp(path.join(tmpdir(), 'browser-recipes-legacy-'));
const stagedExtension = path.join(stage, 'extension');
let server;
let browser;
const verifyUi5 = process.env.VERIFY_UI5 === '1';

async function startServer() {
  server = spawn(process.execPath, [
    path.join(fakeRoot, 'server.mjs'), '--port', '0', '--user', 'FIXTURE',
    '--data', path.join(stage, 'fixture-db.json'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The fake application did not start.')), 5000);
    const done = (error, port) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(`http://127.0.0.1:${port}`);
    };
    let output = '';
    server.stdout.on('data', bytes => {
      output += bytes.toString();
      const port = output.match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) done(null, port);
    });
    server.once('error', done);
    server.once('exit', code => done(new Error(`Fake application exited (${code}).`)));
  });
}

async function extensionRequest(page, command, args = {}) {
  return await page.evaluate(({ command, args }) => chrome.runtime.sendMessage({ command, args }), { command, args });
}

async function execute(runner, tab, recipeId, inputs = {}) {
  const { result, error } = await extensionRequest(runner, 'run', { ...tab, recipeId, inputs });
  if (error) throw new Error(JSON.stringify(error));
  return result.outputs;
}

try {
  const origin = await startServer();
  await cp(path.join(root, 'dist'), stagedExtension, { recursive: true });
  const manifestPath = path.join(stagedExtension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', ...(verifyUi5 ? ['http://localhost/*'] : [])];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const bundle = JSON.parse(await readFile(path.join(root, 'examples/legacy-forms/catalog.json'), 'utf8'))
    .filter(adapter => verifyUi5 || !adapter.id.startsWith('fake-sapui5'))
    .map(adapter => ({ ...adapter, origin, ...(adapter.frame ? {
      frame: { ...adapter.frame, origin: origin.replace('127.0.0.1', 'localhost') },
    } : {}) }));
  browser = await chromium.launchPersistentContext(path.join(stage, 'profile'), {
    channel: 'chromium', headless: true, executablePath: process.env.CHROMIUM_PATH,
    args: [
      '--load-extension=' + stagedExtension, '--disable-extensions-except=' + stagedExtension,
      '--no-proxy-server',
      // Chromium can block the fake launchpad's 127.0.0.1 to localhost iframe.
      ...(verifyUi5 ? ['--disable-features=LocalNetworkAccessChecks'] : []), verifyUi5
        ? '--host-resolver-rules=MAP localhost 127.0.0.1'
        : '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  if (verifyUi5) {
    await browser.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/launchpad/') {
        const response = await route.fetch();
        const text = await response.text();
        await route.fulfill({ response, body: text.replaceAll('http://localhost:8790', origin.replace('127.0.0.1', 'localhost')) });
      } else if (url.protocol === 'chrome-extension:' || [origin, origin.replace('127.0.0.1', 'localhost'), 'https://ui5.sap.com'].includes(url.origin)) {
        await route.continue();
      } else {
        await route.abort();
      }
    });
  }
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionOrigin = 'chrome-extension://' + new URL(worker.url()).hostname;
  const zcal = await browser.newPage();
  const invoice = await browser.newPage();
  await zcal.goto(origin + '/index.html');
  await invoice.goto(origin + '/concur/index.html');
  await zcal.locator('#sysmsg-ok').waitFor();
  await invoice.getByText('FIXTURE', { exact: true }).waitFor();
  let ui5;
  let launchpad;
  if (verifyUi5) {
    ui5 = await browser.newPage();
    launchpad = await browser.newPage();
    await Promise.all([ui5.goto(origin + '/sapcal/'), launchpad.goto(origin + '/launchpad/')]);
    await ui5.locator('#sysmsgBox').waitFor({ timeout: 45000 });
    await launchpad.frameLocator('#app').locator('#sysmsgBox').waitFor({ timeout: 45000 });
  }

  const options = await browser.newPage();
  await options.goto(extensionOrigin + '/options.html');
  await installDefinitions(options, bundle);
  await options.getByRole('button', { name: 'Grant access for ' + origin }).click();
  await options.getByRole('button', { name: 'Revoke access for ' + origin }).waitFor();
  if (verifyUi5) {
    const frameOrigin = origin.replace('127.0.0.1', 'localhost');
    await options.getByRole('button', { name: 'Grant access for ' + frameOrigin }).click();
    await options.getByRole('button', { name: 'Revoke access for ' + frameOrigin }).waitFor();
  }

  const runner = await browser.newPage();
  await runner.goto(extensionOrigin + '/runner.html');
  await runner.getByText('Select the tab you want the recipe to use.').waitFor();
  const { result } = await extensionRequest(runner, 'tabs');
  const target = adapterId => {
    const candidates = result.filter(tab => tab.adapterIds.includes(adapterId));
    assert.equal(candidates.length, 1);
    return { tabId: candidates[0].tabId, adapterId };
  };
  const appointments = target('fake-zcal');
  const invoices = target('fake-invoice');
  assert.notEqual(appointments.tabId, invoices.tabId);
  const wrongPath = await extensionRequest(runner, 'run', {
    ...appointments, tabId: invoices.tabId, recipeId: 'read-appointments',
  });
  assert.equal(wrongPath.error?.code, 'PATH_NOT_ALLOWED');
  await zcal.bringToFront();
  const activeRead = await extensionRequest(runner, 'run', { ...appointments, recipeId: 'read-appointments' });
  assert.equal(activeRead.error?.code, 'ACTIVE_TAB');
  await runner.bringToFront();

  await execute(runner, appointments, 'acknowledge-startup');
  assert.deepEqual((await execute(runner, appointments, 'read-appointments')).appointments, []);
  const timed = {
    subject: 'Fixture workshop', date: '01.02.2027', start: '09:00:00', end: '10:00:00',
    organizer: 'Fixture organizer', location: 'Training room',
  };
  const allDay = { subject: 'Fixture away day', date: '02.02.2027', organizer: '', location: 'Demo' };
  assert.match((await execute(runner, appointments, 'stage-timed', timed)).check, /No errors/);
  assert.deepEqual(await (await fetch(origin + '/api/appointments')).json(), []);
  const mismatch = await extensionRequest(runner, 'run', {
    ...appointments, recipeId: 'save-timed', inputs: { ...timed, subject: 'Wrong draft' },
  });
  assert.ok(mismatch.error);
  assert.deepEqual(await (await fetch(origin + '/api/appointments')).json(), []);
  assert.match((await execute(runner, appointments, 'save-timed', timed)).receipt, /Appointment \d+ created/);
  assert.match((await execute(runner, appointments, 'stage-all-day', allDay)).check, /No errors/);
  assert.match((await execute(runner, appointments, 'save-all-day', allDay)).receipt, /Appointment \d+ created/);
  const appointmentRows = (await execute(runner, appointments, 'read-appointments')).appointments;
  assert.equal(appointmentRows.length, 2);
  assert.match(appointmentRows[0].text, /Fixture workshop/);
  const savedAppointments = await (await fetch(origin + '/api/appointments')).json();
  assert.equal(savedAppointments[0].location, 'Training room');
  assert.equal(savedAppointments[1].allDay, true);
  assert.equal(savedAppointments[0].costCenter, '');

  const invoiceFields = {
    vendor: 'Fixture Office Supply', 'invoice-number': 'DEMO-0001', 'invoice-date': '2027-02-01',
    'due-date': '2027-03-01', 'bill-to': 'AlixPartners, LLP (US)', currency: 'USD',
    net: '12.00', tax: '0.50', total: '12.50', po: 'PO0000001', terms: 'Net 30',
  };
  assert.match((await execute(runner, invoices, 'stage-invoice', invoiceFields)).check, /No errors found/);
  assert.deepEqual((await (await fetch(origin + '/api/invoices')).json()).invoices, []);
  await invoice.getByRole('button', { name: 'Save invoice' }).click();
  await invoice.getByText(/Invoice INV\d+ saved/).waitFor();
  await runner.bringToFront();
  const invoiceRows = (await execute(runner, invoices, 'read-invoices')).invoices;
  assert.equal(invoiceRows.length, 1);
  assert.match(invoiceRows[0].text, /Fixture Office Supply/);
  assert.match(invoiceRows[0].text, /DEMO-0001/);
  const secondInvoice = { ...invoiceFields, 'invoice-number': 'DEMO-0002' };
  await execute(runner, invoices, 'stage-invoice', secondInvoice);
  const incorrectTotal = await extensionRequest(runner, 'run', {
    ...invoices, recipeId: 'save-invoice', inputs: { ...secondInvoice, total: '13.50' },
  });
  assert.equal(incorrectTotal.error?.code, 'ASSERTION_FAILED');
  assert.equal((await (await fetch(origin + '/api/invoices')).json()).invoices.length, 1);
  assert.match((await execute(runner, invoices, 'save-invoice', secondInvoice)).receipt, /Invoice INV\d+ saved/);
  const finalRows = (await execute(runner, invoices, 'read-invoices')).invoices;
  assert.equal(finalRows.length, 2);
  assert.match(finalRows[0].text, /DEMO-0002/);
  if (verifyUi5) {
    for (const [adapterId, page] of [['fake-sapui5', ui5], ['fake-sapui5-frame', launchpad]]) {
      const selected = target(adapterId);
      await execute(runner, selected, 'acknowledge-startup');
      const details = { ...timed, subject: 'Fixture ' + adapterId };
      await execute(runner, selected, 'stage-timed', details);
      const view = adapterId.endsWith('-frame') ? page.frameLocator('#app') : page;
      try {
        assert.match((await execute(runner, selected, 'save-timed', details)).receipt, /Appointment \d+ created/);
      } catch (error) {
        const dialog = await view.locator('.sapMMessageBox.sapMDialogOpen').allTextContents();
        throw new Error(`Synthetic UI5 dialog: ${dialog.join(' ')}. ${error.message}`, { cause: error });
      }
      await view.locator('#apptTable').getByText(details.subject, { exact: true }).waitFor();
      const rows = (await execute(runner, selected, 'read-appointments')).appointments;
      assert.ok(rows.some(row => row.text.includes(details.subject)));
    }
    console.log('PASS SAPUI5 direct and cross-origin launchpad fixture staging, confirmation, and readback.');
  }
  console.log('PASS loopback ZCAL timed/all-day checks and receipts, draft mismatch protection, invoice preview and separately approved saves, path scope, inactive-tab enforcement.');
} finally {
  await browser?.close();
  server?.kill();
  await rm(stage, { recursive: true, force: true });
}
