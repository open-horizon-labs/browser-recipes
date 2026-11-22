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
    await runner.getByText('Select the tab you want the recipe to use.').waitFor();
    const tab = runner.getByLabel('Browser tab');
    const recipe = runner.getByLabel('Recipe', { exact: true });
    assert.equal(await tab.inputValue(), '');
    assert.equal(await runner.getByRole('button', { name: 'Run recipe' }).isDisabled(), true);
    await tab.selectOption({ index: 1 });
    const focusedTabId = await active();
    assert.notEqual(Number(await tab.inputValue()), focusedTabId);
    await recipe.selectOption('workshop/runner-upload');
    await runner.getByLabel('message', { exact: true }).fill('Sent');
    await runner.getByLabel('file', { exact: true }).setInputFiles({
      name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello'),
    });
    await runner.getByRole('button', { name: 'Refresh tabs' }).click();
    await runner.getByRole('button', { name: 'Run recipe' }).click();
    await runner.getByText('Sent example.txt Hello', { exact: true }).waitFor();
    assert.equal(await target.locator('#receipt').textContent(), 'Sent example.txt Hello');
    assert.equal(await active(), focusedTabId);
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('bridgeEnabled'))).bridgeEnabled, undefined);
    assert.equal(await runner.getByRole('link', { name: 'Calendar sync' }).getAttribute('target'), '_blank');
    assert.equal(await runner.getByRole('link', { name: 'Settings' }).getAttribute('target'), '_blank');

    await target.goto(new URL('/', target.url()).href);
    await recipe.selectOption('workshop/read-scan');
    await runner.getByRole('button', { name: 'Run recipe' }).click();
    await runner.getByText(/TARGET_UNAVAILABLE.*Step 1/).waitFor({ timeout: 6000 });
    assert.equal(await active(), focusedTabId);
    await runner.setViewportSize({ width: 320, height: 750 });
    assert.equal(await runner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await runner.close();
  }
}
