import assert from 'node:assert/strict';

export const uploadRecipe = {
  id: 'runner-upload',
  title: 'Upload a workshop attachment',
  inputs: { message: { type: 'string' }, file: { type: 'attachment' } },
  steps: [
    { op: 'navigate', path: '/upload.html' },
    { op: 'fill', selector: '#message', input: 'message' },
    { op: 'attach', selector: '#file', input: 'file' },
    { op: 'assert', selector: '#receipt', text: 'example.txt Hello' },
    { op: 'read', selector: '#receipt', as: 'receipt' },
  ],
};

export async function verifyRunner({ browser, worker, extensionOrigin, target, active }) {
  assert.equal((await worker.evaluate(() => chrome.sidePanel.getPanelBehavior())).openPanelOnActionClick, true);
  assert.equal((await worker.evaluate(() => chrome.sidePanel.getOptions({}))).path, 'runner.html');
  const runner = await browser.newPage();
  try {
    await runner.goto(extensionOrigin + '/runner.html');
    await runner.locator('#quick-reads').waitFor();
    await runner.getByText('Set up a run',{exact:true}).click();
    const tab = runner.getByLabel('Browser tab');
    const recipe = runner.getByLabel('Recipe', { exact: true });
    assert.equal(await tab.inputValue(), 'open-app');
    assert.equal(await runner.getByRole('button', { name: 'Run here', exact: true }).isDisabled(), true);
    await tab.selectOption({ index: 2 });
    const focusedTabId = await active();
    assert.notEqual(Number(await tab.inputValue()), focusedTabId);
    const quick = runner.locator('#read-list');
    assert.equal(await quick.getByRole('button',{name:/Upload a workshop attachment.*Set up/}).count(),1);
    await quick.getByRole('button',{name:/Open ticket 42 and read its title/}).click();
    await runner.getByRole('link',{name:'Inspect run'}).waitFor();
    assert.ok(await runner.locator('#results').isVisible());
    assert.equal(await active(),focusedTabId);
    const sourceId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,target.url());
    await runner.goto(extensionOrigin + '/runner.html?fromTab=' + sourceId);
    await runner.getByRole('heading',{name:'Recipes for this tab'}).waitFor();
    const labels = await quick.getByRole('button').allTextContents();
    assert.ok(labels.length > 1 && labels.every(label => label.includes('Local recipe workshop')));
    await runner.getByRole('button',{name:'All apps',exact:true}).click();
    assert.ok(await quick.getByRole('button').count() > labels.length);
    await runner.getByRole('button',{name:'This tab',exact:true}).click();
    await quick.getByRole('button',{name:/Upload a workshop attachment/}).click();
    assert.equal(await tab.inputValue(),String(sourceId));
    assert.equal(await recipe.inputValue(),uploadRecipe.title);
    await runner.goto(extensionOrigin + '/options.html');
    const adapter = runner.locator('#adapter-list > details').filter({has:runner.getByRole('button',{name:'Run Open ticket 42 and read its title',includeHidden:true})});
    await adapter.locator(':scope > summary').click();
    await adapter.getByRole('button',{name:'Run Open ticket 42 and read its title'}).click();
    await adapter.getByRole('link',{name:'Inspect run'}).waitFor();
    assert.match(runner.url(), /options\.html$/);
    assert.match(await adapter.locator('.recipe-result pre').textContent(),/Ticket 42/);
    await runner.reload();
    await adapter.locator(':scope > summary').click();
    assert.equal(await adapter.getByRole('link',{name:'Inspect run'}).count(),0);
    const section = runner.locator('#adapter-list > details').filter({has:runner.getByRole('link',{name:'Set up '+uploadRecipe.title,includeHidden:true})});
    await section.getByRole('link',{name:'Set up '+uploadRecipe.title}).click();
    await runner.waitForFunction(title => document.querySelector('#recipe')?.value === title,uploadRecipe.title);
    assert.equal(await tab.inputValue(),'open-app');
    await tab.selectOption(String(await worker.evaluate(async url => (await chrome.tabs.query({})).find(t=>t.url===url).id,target.url())));
    await runner.getByLabel('message', { exact: true }).fill('Sent');
    await runner.getByLabel('file', { exact: true }).setInputFiles({
      name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello'),
    });
    const originalSelection = await tab.inputValue();
    const extra = await browser.newPage();
    await extra.goto(new URL('/',target.url()).href);
    const extraId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id,extra.url());
    await tab.locator(`option[value="${extraId}"]`).waitFor({state:'attached'});
    assert.equal(await tab.inputValue(),originalSelection);
    assert.equal(await runner.getByLabel('message',{exact:true}).inputValue(),'Sent');
    await extra.close();
    await tab.locator(`option[value="${extraId}"]`).waitFor({state:'detached'});
    await runner.getByRole('button', { name: 'Run here', exact: true }).click();
    await runner.getByText('Sent example.txt Hello', { exact: true }).waitFor();
    assert.equal(await target.locator('#receipt').textContent(), 'Sent example.txt Hello');
    assert.equal(await active(), focusedTabId);
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('bridgeEnabled'))).bridgeEnabled, undefined);
    assert.equal(await runner.getByRole('link', { name: 'Workflows' }).getAttribute('target'), '_blank');
    assert.equal(await runner.getByRole('link', { name: 'Settings' }).getAttribute('target'), '_blank');

    await target.goto(new URL('/', target.url()).href);
    await runner.getByRole('button',{name:'Browse recipes'}).click();
    await runner.getByRole('option',{name:/Read test scan/}).waitFor();
    await recipe.fill('no such recipe');
    await runner.getByText('No matching recipes.',{exact:true}).waitFor();
    await recipe.press('Escape');
    assert.equal(await recipe.inputValue(),uploadRecipe.title);
    await recipe.fill('read scan');
    await recipe.press('ArrowDown');
    assert.ok(await recipe.getAttribute('aria-activedescendant'));
    if (process.env.RECIPE_PICKER_IMAGE) {
      await runner.setViewportSize({width:360,height:850});
      await runner.screenshot({path:process.env.RECIPE_PICKER_IMAGE});
    }
    await recipe.press('Enter');
    assert.equal(await recipe.inputValue(),'Read test scan');
    await runner.getByRole('button', { name: 'Run here', exact: true }).click();
    await runner.getByText(/TARGET_UNAVAILABLE.*Step 1/).waitFor({ timeout: 6000 });
    assert.equal(await active(), focusedTabId);
    await runner.setViewportSize({ width: 320, height: 750 });
    assert.equal(await runner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await runner.close();
  }
}
