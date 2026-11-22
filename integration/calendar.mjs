import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFile, chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const fixture = name => new URL(`fixtures/${name}`, import.meta.url);
const calendarFixture = name => fixture('calendar/' + name);

async function servePages(pages) {
  const contents = new Map(await Promise.all(
    Object.entries(pages).map(async ([route, file]) => [route, await readFile(fixture(file))]),
  ));
  const server = createServer((request, response) => {
    const page = contents.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export async function setupWorkflows({ extensionId, hosts, stage }) {
  const executable = path.join(stage, 'calendar-native-host.py');
  await Promise.all([
    copyFile(calendarFixture('native_host.py'), executable),
    copyFile(calendarFixture('normalized.json'), path.join(stage, 'normalized.json')),
  ]);
  await chmod(executable, 0o700);
  const name = 'org.openhorizonlabs.browser_recipes_agent';
  await writeFile(path.join(hosts, `${name}.json`), JSON.stringify({
    name, description: 'Browser Recipes workflow test',
    path: executable, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
  }));
  const catalogPath = process.env.BROWSER_RECIPES_CATALOG;
  const packed = catalogPath && JSON.parse(execFileSync(process.execPath,[path.join(catalogPath,'scripts/pack.mjs')]));
  const adapters = packed ? packed.adapters : JSON.parse(await readFile(calendarFixture('adapters.json')));
  const workflows = packed ? packed.workflows.filter(w => ['outlook-to-google-calendar','compare-hacker-news'].includes(w.id)) : JSON.parse(await readFile(calendarFixture('workflows.json')));
  const pages = [];
  async function serve(routes) {
    const result = await servePages(routes);
    pages.push(result);
    return result;
  }
  const close = () => Promise.all(pages.map(page => page.close()));
  try {
    const source = await serve({ '/week': 'calendar/outlook.html' });
    const destination = await serve({ '/calendar/u/1/r/week': 'calendar/google.html', '/calendar/u/1/r/settings/export': 'calendar/import.html' });
    const news = await serve({ '/news': 'news/front.html', '/newest': 'news/newest.html' });
    const office = packed ? await serve({ '/week': 'calendar/outlook.html' }) : source;
    const sites = {outlook:source,'outlook-office':office,'google-calendar':destination,'hacker-news':news};
    const bundle = {
      adapters: adapters.filter(a => Object.hasOwn(sites,a.id)).map(adapter => ({ ...adapter, origin: sites[adapter.id].origin })),
      workflows,
    };
    return {
      bundle, source, office, destination, news,
      reconnect: () => unlink(path.join(stage, 'disconnected')),
      disconnect: () => writeFile(path.join(stage, 'disconnected'), ''),
      commands: async () => (await readFile(path.join(stage, 'native-requests.log'), 'utf8')).trim().split('\n'),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function verifyWorkflows(context) {
  const sameFile = content => content.replace(/^DTSTAMP:[^\r\n]+/gm, 'DTSTAMP:');
  const native = await verifyCalendarRoute(context, []);
  await context.fixtures.disconnect();
  const desktop = await verifyCalendarRoute(context, ['status', 'models', 'plan'], { desktop: true });
  assert.equal(sameFile(native), sameFile(desktop));
  await verifyHeadlines(context);
  await context.fixtures.reconnect();
  await verifyGuide(context);
  await verifyRecipeEdits(context);
  await verifySharedCalendarPreview(context);
}

async function selectWorkflow(page, id) {
  const selector = page.locator('#workflow');
  await selector.locator(`option[value="${id}"]`).waitFor({ state: 'attached' });
  assert.equal(await selector.inputValue(), '');
  await selector.selectOption(id);
}

async function verifyCalendarRoute({ browser, extensionOrigin, fixtures, active }, priorRequests, { desktop = false } = {}) {
  const source = await browser.newPage();
  const destination = await browser.newPage();
  const runner = await browser.newPage();
  try {
    await source.goto((desktop ? fixtures.office : fixtures.source).origin + '/week');
    await destination.goto(fixtures.destination.origin + '/calendar/u/1/r/week');
    await runner.goto(extensionOrigin + '/agent.html');
    await selectWorkflow(runner, 'outlook-to-google-calendar');
    await runner.locator('summary').filter({ hasText: 'ChatGPT connection' }).click();
    await runner.locator('#account').getByText(desktop ? 'Disconnected' : 'Connected to ChatGPT', { exact: true }).waitFor();
    const start = [...priorRequests, 'status', ...(desktop ? [] : ['models'])];
    const activeBefore = await active();
    const sourcePicker = runner.locator('#tab-source');
    const destinationPicker = runner.locator('#tab-destination');
    assert.equal(await sourcePicker.inputValue(), '');
    assert.equal(await destinationPicker.inputValue(), '');
    assert.equal(await runner.locator('#execute-step').count(), 0);
    await sourcePicker.selectOption({ index: 1 });
    await destinationPicker.selectOption({ index: 1 });
    assert.notEqual(await sourcePicker.inputValue(), await destinationPicker.inputValue());
    await runner.locator('#advance').click();
    const reviewed = runner.locator('#review-inputs');
    await reviewed.waitFor();
    const data = JSON.parse(await reviewed.inputValue());
    assert.equal(data.outlook.events.length, 2);
    assert.equal(await source.locator("#mectrl_main_body").isVisible(), false);
    assert.equal(data.google.events[0].attributes['data-eventid'], 'destination-1');
    await reviewed.fill((await reviewed.inputValue()).replaceAll('Workshop', 'Reviewed workshop'));
    await runner.locator('#field-first').fill('2027-02-01');
    await runner.locator('#field-last').fill('2027-02-07');
    await runner.locator('#field-source-zone').fill('America/New_York');
    await runner.locator('#field-destination-zone').fill('America/New_York');
    if (!desktop) await runner.getByRole('option', { name: 'Fixture model' }).waitFor({ state: 'attached' });
    assert.deepEqual(await fixtures.commands(), start);

    // The workflow must leave the background week alone during preview.
    const file = destination.locator('input[type=file]');
    const assertActions = async (attachments, imports) => {
      if (new URL(destination.url()).pathname.endsWith('/week')) {
        assert.equal(attachments + imports, 0);
        return;
      }
      assert.equal(await destination.locator('#attachments').textContent(), String(attachments));
      assert.equal(await destination.locator('#imports').textContent(), String(imports));
      assert.equal(await file.evaluate(control => control.files.length), attachments);
    };
    await assertActions(0, 0);
    if (desktop) {
      assert.equal(await runner.locator('#compare').isDisabled(), true);
      await runner.locator('#agent-mode').selectOption('manual');
      await runner.locator('#prepare').click();
      await runner.getByText('Copy the prompt into your desktop chat.', { exact: true }).waitFor();
      const prompt = await runner.locator('#prompt').inputValue();
      assert.match(prompt, /Reviewed workshop/);
      assert.match(prompt, /destination-1/);
      await runner.locator('#reply').fill('```json\n' + await readFile(calendarFixture('normalized.json'), 'utf8') + '```');
      await runner.locator('#use-reply').click();
    } else {
      await runner.locator('#compare').click();
    }
    const expectedRequests = [...start, ...(desktop ? [] : ['plan'])];
    await runner.getByRole('heading', { name: 'Compare the weeks and select missing blocks' }).waitFor();
    await assertActions(0, 0);
    await runner.locator('#execute-step').click();
    const review = runner.locator('#selection');
    const option = review.getByRole('checkbox', { name: /Reviewed workshop/ });
    await option.waitFor();
    if (process.env.WORKFLOW_REVIEW_IMAGE) await runner.locator("#current").screenshot({path:process.env.WORKFLOW_REVIEW_IMAGE});
    assert.equal(await review.getByRole('checkbox').count(), 1);
    assert.equal(await option.isChecked(), false);
    assert.equal(await runner.locator('#apply-selection').isDisabled(), true);
    await assertActions(0, 0);
    await option.check();
    await assertActions(0, 0);
    await runner.locator('#apply-selection').click();
    await runner.locator('#field-copy-titles').waitFor();
    assert.equal(await runner.locator('#field-copy-titles').isChecked(), false);
    await assertActions(0, 0);
    await runner.locator('#execute-step').click();
    assert.equal(new URL(destination.url()).pathname, '/calendar/u/1/r/week');
    await runner.getByLabel('Destination calendar name').fill('Outlook busy');
    await runner.getByRole('button', {name:'Choose destination calendar'}).click();
    const approval = runner.getByRole('button', { name: 'Import approved blocks into Google Calendar' });
    await approval.waitFor();
    await assertActions(0, 0);
    assert.equal(await runner.locator('#advance').count(), 0);

    // The selected tab still matches the adapter origin after an account switch. The write must detect it before attaching.
    await destination.goto(fixtures.destination.origin + '/calendar/u/1/r/settings/export?account=other');
    await approval.click();
    await runner.locator('#status').getByText(/ASSERTION_FAILED|ACCOUNT_CHANGED|assertion|account/i).waitFor();
    await assertActions(0, 0);
    await destination.goto(fixtures.destination.origin + '/calendar/u/1/r/settings/export');
    await assertActions(0, 0);
    await approval.click();
    await runner.locator('#status').getByText('Workflow complete.', { exact: true }).waitFor();
    await assertActions(1, 1);
    assert.equal(await destination.locator('p[role=status]').textContent(), 'Imported 1 of 1 event(s)');
    const staged = await file.evaluate(async control => ({ name: control.files[0].name, content: await control.files[0].text() }));
    assert.match(staged.name, /\.ics$/);
    assert.equal((staged.content.match(/BEGIN:VEVENT/g) ?? []).length, 1);
    assert.match(staged.content, /DTSTART:20270201T140000Z/);
    assert.match(staged.content, /SUMMARY:Busy/);
    assert.doesNotMatch(staged.content, /Reviewed workshop|Standup/);
    assert.equal(await active(), activeBefore);
    assert.deepEqual(await fixtures.commands(), expectedRequests);
    return staged.content;
  } finally {
    await Promise.all([source.close(), destination.close(), runner.close()]);
  }
}

async function verifyHeadlines({ browser, extensionOrigin, fixtures, active }) {
  const page = await browser.newPage();
  const runner = await browser.newPage();
  try {
    await page.goto(fixtures.news.origin + '/news');
    const prior = await fixtures.commands();
    await runner.goto(extensionOrigin + '/agent.html');
    await selectWorkflow(runner, 'compare-hacker-news');
    const before = await active();
    const picker = runner.locator('#tab-news');
    assert.equal(await picker.inputValue(), '');
    await picker.selectOption({ index: 1 });
    await runner.locator('#advance').click();
    await runner.getByText('All workflow steps are complete.').waitFor();
    assert.equal(new URL(page.url()).pathname, '/newest');
    const comparison = runner.locator('#steps li').last();
    await comparison.getByText('View result', { exact: true }).click();
    assert.match(await comparison.locator('pre').textContent(), /Fixture front-page headline/);
    assert.match(await comparison.locator('pre').textContent(), /Fixture newest headline/);
    assert.equal(await active(), before);
    assert.deepEqual(await fixtures.commands(), [...prior, 'status']);
    if (process.env.WORKFLOW_RUNNER_IMAGE) {
      const tabId = await picker.inputValue();
      await runner.goto(extensionOrigin + '/runner.html');
      await runner.setViewportSize({width:405,height:614});
      await runner.locator('#recipe-setup summary').click();
      await runner.locator('#tab').selectOption(tabId);
      await runner.locator('#recipe').fill('hacker-news/front-page');
      await runner.locator('#recipe').press('Enter');
      await runner.locator('#run').click();
      await runner.locator('#results').getByText('Fixture front-page headline').waitFor();
      await runner.screenshot({path:process.env.WORKFLOW_RUNNER_IMAGE});
    }
  } finally {
    await Promise.all([page.close(), runner.close()]);
  }
}

async function verifyGuide({ browser, extensionOrigin, fixtures }) {
  const runner = await browser.newPage();
  try {
    const before = await fixtures.commands();
    await runner.goto(extensionOrigin + '/agent.html');
    await selectWorkflow(runner, 'compare-hacker-news');
    await runner.locator('#guide summary').click();
    await runner.locator('#guide-question').fill('Which tab should I select?');
    await runner.locator('#prepare-guide').click();
    assert.match(await runner.locator('#guide-prompt').inputValue(), /Which tab should I select/);
    await runner.locator('#guide-model option[value=fixture-model]').waitFor({state:'attached'});
    assert.deepEqual(await fixtures.commands(), [...before,'status','models']);
    await runner.locator('#ask-guide').click();
    await runner.locator('#guide-conversation').getByText('Choose the tab with the news page.').waitFor();
    assert.deepEqual(await fixtures.commands(), [...before,'status','models','plan']);
    await runner.locator('#guide-question').fill('Check session recovery');
    await runner.locator('#prepare-guide').click();
    await runner.locator('#ask-guide').click();
    await runner.locator('#status').getByText(/session expired/).waitFor();
    await runner.locator('#session summary').click();
    await runner.locator('#signin').waitFor();
    assert.equal(await runner.locator('#ask-guide').isDisabled(), true);
    assert.deepEqual(await fixtures.commands(), [...before,'status','models','plan','plan']);
  } finally {
    await runner.close();
  }
}

async function verifyRecipeEdits({browser,extensionOrigin,fixtures,active}) {
  const source = await browser.newPage();
  const dest = await browser.newPage();
  const runner = await browser.newPage();
  try {
    await source.goto(fixtures.source.origin + '/week');
    await dest.goto(fixtures.destination.origin + '/calendar/u/1/r/week');
    await runner.goto(extensionOrigin + '/agent.html');
    await selectWorkflow(runner,'outlook-to-google-calendar');
    const front = await active();
    await runner.locator('#tab-source').selectOption({index:1});
    await runner.locator('#tab-destination').selectOption({index:1});
    await runner.locator('#review-recipes').check();
    await runner.locator('#execute-step').click();
    const current = runner.locator('#current');
    await current.getByText('Filter or change outputs with ChatGPT').click();
    await current.getByLabel('Instructions for these outputs').fill('Remove the second fixture event and rename the first.');
    await current.getByText('Review request',{exact:true}).click();
    await current.getByText('Send edit request to ChatGPT').click();
    await current.getByText('Use proposed outputs').click();
    await runner.locator('#continue-output').click();
    await runner.locator('#execute-step').click();
    await runner.locator('#continue-output').click();
    await runner.locator('#advance').click();
    const reviewed = JSON.parse(await runner.locator('#review-inputs').inputValue());
    assert.equal(reviewed.outlook.events.length,1);
    assert.equal(reviewed.outlook.events[0].text,'Edited fixture event');
    await runner.goto(extensionOrigin + '/runner.html');
    const tabId = await runner.evaluate(async () => (await chrome.runtime.sendMessage({command:'tabs',args:{}})).result.find(t => t.adapterIds.includes('workshop')).tabId);
    await runner.locator('#recipe-setup summary').click();
    await runner.locator('#tab').selectOption(String(tabId));
    await runner.locator('#recipe').fill('workshop/runner-upload');
    await runner.getByRole('option',{name:/Upload a workshop attachment/}).click();
    const inputs = runner.locator('#inputs');
    const message = inputs.getByLabel('message',{exact:true});
    await message.fill('Original');
    await inputs.getByText('Filter or change inputs with ChatGPT').click();
    await inputs.getByLabel('Instructions for these inputs').fill('Change the fixture message to Edited.');
    await inputs.getByText('Review request',{exact:true}).click();
    await inputs.getByText('Send edit request to ChatGPT').waitFor();
    const requests = await fixtures.commands();
    const origin = await runner.evaluate(async () => {
      const {result} = await chrome.runtime.sendMessage({command:'runner.list',args:{}});
      return result.catalog.find(adapter => adapter.id === 'workshop').origin;
    });
    await runner.evaluate(origin => chrome.storage.local.set({blockedModelOrigins:[origin]}),origin);
    await inputs.getByText('Send edit request to ChatGPT').click();
    await inputs.getByRole('status').getByText(/needs permission/).waitFor();
    assert.deepEqual(await fixtures.commands(),requests);
    await runner.evaluate(() => chrome.storage.local.remove('blockedModelOrigins'));
    await inputs.getByText('Send edit request to ChatGPT').click();
    await inputs.getByText('Use proposed inputs').waitFor();
    assert.equal(await message.inputValue(),'Original');
    await inputs.getByText('Use proposed inputs').click();
    assert.equal(await message.inputValue(),'Edited');
    assert.equal(await active(),front);
  } finally {
    await Promise.all([source.close(),dest.close(),runner.close()]);
  }
}

async function verifySharedCalendarPreview({browser, extensionOrigin, fixtures, active}) {
  const source = await browser.newPage();
  const destination = await browser.newPage();
  const runner = await browser.newPage();
  try {
    await source.goto(fixtures.source.origin + '/week');
    await destination.goto(fixtures.destination.origin + '/calendar/u/1/r/week');
    await runner.goto(extensionOrigin + '/runs.html');
    const front = await active();
    const send = (command,args = {}) => runner.evaluate(async ([command,args]) => {
      const response = await chrome.runtime.sendMessage({command,args});
      if (response.error) throw new Error(response.error.message);
      return response.result;
    },[command,args]);
    const tabs = await send('tabs');
    const target = adapter => tabs.find(tab => tab.adapterIds.includes(adapter)).tabId;
    let run = await send('runs.start',{kind:'workflow',workflowId:'outlook-to-google-calendar',
      tabs:{source:target('outlook'), destination:target('google-calendar')}});
    assert.equal(run.pending?.tag,'fields');
    run = await send('runs.resume',{runId:run.runId,actionId:run.pending.id,answer:{
      fields:{first:'2027-02-01', last:'2027-02-07', 'source-zone':'America/New_York', 'destination-zone':'America/New_York'}}});
    assert.equal(run.pending?.tag,'agent');
    await runner.goto(extensionOrigin + '/runs.html#' + run.runId);
    const countPlans = async () => (await fixtures.commands()).filter(command => command === 'plan').length;
    const before = await countPlans();
    await runner.getByRole('button',{name:'Review what goes to ChatGPT'}).click();
    const data = runner.getByLabel('Data to share (JSON)',{exact:true});
    await data.fill((await data.inputValue()).replaceAll('Workshop','Reviewed workshop'));
    await runner.getByRole('option',{name:'Fixture model'}).waitFor({state:'attached'});
    assert.equal(await countPlans(),before);
    await runner.getByRole('button',{name:'Send to ChatGPT'}).click();
    await runner.getByText('Review the model reply before continuing.').waitFor();
    assert.equal(await countPlans(),before + 1);
    await runner.getByRole('button',{name:'Use reviewed reply'}).click();
    await runner.getByRole('checkbox',{name:/Reviewed workshop/}).waitFor();
    const preview = await send('runs.get',{runId:run.runId,includeData:true});
    assert.equal(preview.pending.tag,'selection');
    assert.equal(preview.context.choices.length,1);
    await send('runs.cancel',{runId:run.runId});
    assert.equal(await active(),front);
    assert.equal(destination.url(),fixtures.destination.origin + '/calendar/u/1/r/week');
    console.log('PASS shared Runs UI reviewed the calendar prompt and reached selection without importing.');
  } finally { await Promise.all([source.close(),destination.close(),runner.close()]); }
}
