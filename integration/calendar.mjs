import assert from 'node:assert/strict';
import { copyFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const fixture = name => new URL(`fixtures/calendar/${name}`, import.meta.url);

async function servePages(pages) {
  const contents = new Map(await Promise.all(
    Object.entries(pages).map(async ([route, file]) => [route, await readFile(fixture(file))]),
  ));
  const server = createServer((request, response) => {
    const page = contents.get(request.url);
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

export async function setupCalendar({ extensionId, hosts, stage }) {
  const executable = path.join(stage, 'calendar-native-host.py');
  await Promise.all([
    copyFile(fixture('native_host.py'), executable),
    copyFile(fixture('normalized.json'), path.join(stage, 'normalized.json')),
  ]);
  await chmod(executable, 0o700);
  const name = 'org.openhorizonlabs.browser_recipes_agent';
  await writeFile(path.join(hosts, `${name}.json`), JSON.stringify({
    name, description: 'Browser Recipes calendar test',
    path: executable, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
  }));
  const adapters = JSON.parse(await readFile(fixture('adapters.json')));
  const source = await servePages({ '/week': 'outlook.html' });
  try {
    const destination = await servePages({ '/week': 'google.html', '/import': 'import.html' });
    return {
      adapters: adapters.map((adapter, index) => ({ ...adapter, origin: (index === 0 ? source : destination).origin })),
      source, destination, log: path.join(stage, 'native-requests.log'),
      disconnect: () => writeFile(path.join(stage, 'disconnected'), ''),
      close: () => Promise.all([source.close(), destination.close()]),
    };
  } catch (error) {
    await source.close();
    throw error;
  }
}

export async function verifyCalendar(context) {
  const generatedWithHelper = await verifyCalendarRoute(context, false, []);
  await context.calendar.disconnect();
  const generatedWithDesktop = await verifyCalendarRoute(context, true, ['status', 'models', 'plan']);
  assert.equal(generatedWithHelper, generatedWithDesktop);
}

async function verifyCalendarRoute({ browser, extensionOrigin, calendar, active }, desktop, priorRequests) {
  const source = await browser.newPage();
  const destination = await browser.newPage();
  const agent = await browser.newPage();
  try {
    await source.goto(calendar.source.origin + '/week');
    await destination.goto(calendar.destination.origin + '/week');
    await agent.goto(extensionOrigin + '/agent.html');
    if (desktop) {
      await agent.getByText('Disconnected', { exact: true }).waitFor();
    } else {
      await agent.getByText('Connected to ChatGPT', { exact: true }).waitFor();
      await agent.getByRole('option', { name: 'Fixture model' }).waitFor({ state: 'attached' });
    }
    const activeBefore = await active();
    const requests = async () => (await readFile(calendar.log, 'utf8')).trim().split('\n');
    assert.deepEqual(await requests(), [...priorRequests, 'status', ...(desktop ? [] : ['models'])]);
    const sourcePicker = agent.getByLabel('Outlook tab');
    const destinationPicker = agent.getByLabel('Google Calendar tab');
    assert.equal(await sourcePicker.inputValue(), '');
    assert.equal(await destinationPicker.inputValue(), '');
    await sourcePicker.selectOption({ index: 1 });
    await destinationPicker.selectOption({ index: 1 });
    assert.notEqual(await sourcePicker.inputValue(), await destinationPicker.inputValue());
    await agent.getByRole('button', { name: 'Read calendars' }).click();
    await agent.getByText('Both reads finished.', { exact: false }).waitFor();
    assert.deepEqual(await requests(), [...priorRequests, 'status', ...(desktop ? [] : ['models'])]);
    const sourceEvents = agent.getByLabel('Outlook events');
    const destinationEvents = agent.getByLabel('Google Calendar events');
    assert.equal(JSON.parse(await sourceEvents.inputValue()).events.length, 2);
    assert.equal(JSON.parse(await destinationEvents.inputValue()).events[0].attributes['data-eventid'], 'destination-1');
    await sourceEvents.fill((await sourceEvents.inputValue()).replaceAll('Workshop', 'Reviewed workshop'));
    await agent.getByLabel('First day shown').fill('2027-02-01');
    await agent.getByLabel('Last day shown').fill('2027-02-07');
    await agent.getByLabel('Outlook time zone').fill('America/New_York');
    await agent.getByLabel('Google Calendar time zone').fill('America/New_York');

    // The user navigates the destination tab to import settings while the runner stays open.
    await destination.goto(calendar.destination.origin + '/import');
    const file = destination.locator('input[type="file"]');
    const importCount = destination.locator('#imports');
    const stagedCount = () => file.evaluate(input => input.files.length);
    const stageButton = agent.getByRole('button', { name: 'Stage selected blocks in Google Calendar' });
    assert.equal(await stageButton.isVisible(), false);
    assert.equal(await stagedCount(), 0);
    if (desktop) {
      await agent.getByText('Use my desktop chat instead', { exact: true }).click();
      await agent.getByRole('button', { name: 'Prepare prompt' }).click();
      const prompt = await agent.getByLabel('Prompt to copy').inputValue();
      assert.match(prompt, /Reviewed workshop/);
      assert.match(prompt, /destination-1/);
      assert.equal(await stageButton.isVisible(), false);
      const reply = await readFile(fixture('normalized.json'), 'utf8');
      await agent.getByLabel('Reply from your chat').fill('```json\n' + reply + '```');
      await agent.getByRole('button', { name: 'Review reply' }).click();
    } else {
      await agent.getByRole('button', { name: 'Send to ChatGPT for comparison' }).click();
    }
    await agent.getByText('1 available to copy.', { exact: false }).waitFor();
    const expectedRequests = [...priorRequests, 'status', ...(desktop ? [] : ['models', 'plan'])];
    assert.deepEqual(await requests(), expectedRequests);
    assert.equal(await stageButton.isDisabled(), true);
    assert.equal(await stagedCount(), 0);
    const block = agent.getByRole('checkbox', { name: /Reviewed workshop/ });
    assert.equal(await block.isChecked(), false);
    await block.check();
    assert.equal(await stagedCount(), 0);
    assert.equal(await importCount.textContent(), '0');

    if (!desktop && process.env.CALENDAR_REVIEW_SCREENSHOT) {
      await agent.setViewportSize({ width: 1000, height: 760 });
      await agent.emulateMedia({ colorScheme: 'light' });
      await agent.locator('#review').screenshot({
        path: process.env.CALENDAR_REVIEW_SCREENSHOT,
        style: '#status { visibility: hidden; }',
      });
    }

    await stageButton.click();
    await agent.getByText(/File staged .*click Import/).waitFor();
    assert.equal(await stagedCount(), 1);
    assert.equal(await importCount.textContent(), '0');
    const staged = await file.evaluate(async input => ({ name: input.files[0].name, content: await input.files[0].text() }));
    assert.equal(staged.name, 'outlook-busy.ics');
    assert.equal((staged.content.match(/BEGIN:VEVENT/g) ?? []).length, 1);
    assert.match(staged.content, /DTSTART:20270201T140000Z/);
    assert.match(staged.content, /SUMMARY:Busy/);
    assert.doesNotMatch(staged.content, /Reviewed workshop|Standup/);
    assert.equal(await active(), activeBefore);
    assert.deepEqual(await requests(), expectedRequests);
    return staged.content.replace(/^DTSTAMP:.*$/gm, '');
  } finally {
    await Promise.all([source.close(), destination.close(), agent.close()]);
  }
}
