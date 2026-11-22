import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const execFile = promisify(execFileCallback);
const runtime = fileURLToPath(new URL('../', import.meta.url));
const catalog = path.resolve(process.env.BROWSER_RECIPES_CATALOG ?? path.join(runtime, '../browser-recipes-catalog'));
const { stdout } = await execFile(process.execPath, [path.join(catalog, 'scripts/pack.mjs')]);
const { adapters, workflows } = JSON.parse(stdout);
const adapter = adapters.find(entry => entry.id === 'google-calendar');
const fixture = await readFile(new URL('./fixtures/google-calendar-editor.html', import.meta.url));
const stage = await mkdtemp(path.join(tmpdir(), 'google-calendar-editor-'));
const extension = path.join(stage, 'extension');
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  adapter.origin = 'http://127.0.0.1:' + server.address().port;
  await cp(path.join(runtime, 'dist'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(path.join(stage, 'profile'), {
    channel: 'chromium', headless: true, executablePath: process.env.CHROMIUM_PATH,
    args: ['--load-extension=' + extension, '--disable-extensions-except=' + extension],
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionOrigin = 'chrome-extension://' + new URL(worker.url()).hostname;
  const options = await browser.newPage();
  await options.goto(extensionOrigin + '/' + manifest.options_ui.page);
  await options.locator('#catalog').fill(JSON.stringify({
    adapters: [adapter], workflows: workflows.filter(entry => /^create-.*-calendar-event$/.test(entry.id)),
  }));
  await options.locator('#save').click();
  await options.getByText('Catalog saved.', { exact: true }).waitFor({ timeout: 5000 });
  await options.getByRole('button', { name: /Grant access for/ }).click();
  await options.getByText('Site access granted.', { exact: true }).waitFor();
  const calendar = await browser.newPage();
  const week = adapter.origin + '/calendar/u/1/r/week';
  for (const timed of [true, false]) {
    const runner = await browser.newPage();
    try {
      await calendar.goto(week);
      await runner.goto(extensionOrigin + '/agent.html');
      const workflow = timed ? 'create-timed-calendar-event' : 'create-all-day-calendar-event';
      await runner.locator(`#workflow option[value="${workflow}"]`).waitFor({ state: 'attached' });
      await runner.locator('#workflow').selectOption(workflow);
      await runner.locator('#tab-calendar').selectOption({ index: 1 });
      const titles = timed ? 'Planning & review?' : 'Away all day';
      const location = timed ? 'Conference + 3 & 4' : '';
      const values = {
        'destination-account': 'Google Account: Fixture calendar', title: titles,
        'start-date': 'Feb 1, 2027', 'end-date': 'Feb 1, 2027', location,
        dates: timed ? '20270201T090000/20270201T103000' : '20270201/20270202',
        ...(timed ? { 'start-time': '09:00', 'end-time': '10:30' } : {}),
      };
      for (const [field, value] of Object.entries(values)) await runner.locator('#field-' + field).fill(value);
      await runner.locator('#execute-step').click();
      const save = runner.getByRole('button', { name: 'Approve and press Save' });
      await save.waitFor({ timeout: 5000 });
      const prepared = new URL(calendar.url());
      assert.equal(prepared.pathname, '/calendar/u/1/r/eventedit');
      assert.equal(prepared.searchParams.get('text'), titles);
      assert.equal(prepared.searchParams.get('location'), location);
      assert.deepEqual([...prepared.searchParams.keys()].sort(), ['dates', 'location', 'text']);
      assert.equal(await calendar.locator('#xAlDaCbx input').isChecked(), !timed);
      const count = () => calendar.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-calendar-events') || '[]').length);
      const before = timed ? 0 : 1;
      assert.equal(await count(), before);
      const existing = new URL(prepared);
      existing.pathname += '/already-existing';
      await calendar.goto(existing.href);
      await save.click();
      await runner.locator('#status').getByText(/PATH_NOT_ALLOWED/).waitFor({ timeout: 5000 });
      assert.equal(await count(), before);
      const wrong = new URL(prepared);
      wrong.searchParams.set('wrong-account', '');
      await calendar.goto(wrong.href);
      await save.click();
      await runner.locator('#status').getByText(/ACCOUNT_CHANGED/).waitFor({ timeout: 5000 });
      assert.equal(await count(), before);
      await calendar.goto(prepared.href);
      await save.click();
      await calendar.waitForURL(week);
      await runner.locator('#field-event-label').fill(titles + ', Fixture event');
      await runner.locator('#execute-step').click();
      await runner.getByText('All workflow steps are complete.', { exact: true }).waitFor({ timeout: 5000 });
      assert.equal(await count(), before + 1);
      assert.equal(await calendar.locator('[data-eventid="fixture-' + (before + 1) + '"]').count(), 1);
    } finally {
      await runner.close();
    }
  }
  console.log('PASS timed and all-day event editor workflows: prefill and review, explicit Save, exact event verification, existing-event and account guards.');
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(stage, { recursive: true, force: true });
}
