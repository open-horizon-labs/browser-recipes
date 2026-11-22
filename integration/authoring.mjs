import assert from 'node:assert/strict';

export async function verifyAuthoring({ target, call, args }) {
  const url = new URL('/files/runtime-smoke.html', target.url()).href;
  await target.route(url, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
<title>Smoke document</title>
<article><h1>Document title</h1><p>Example body</p><form><textarea>excluded</textarea></form></article>
<input id="file" type="file"><output id="output">Waiting</output>
<script>
document.getElementById('file').addEventListener('change', async event => {
  const file = event.target.files[0];
  const content = await file.text();
  setTimeout(() => {
    document.getElementById('output').innerText = file.name + ':' + content;
  }, 250);
});
</script>`,
  }));
  try {
    const { outputs } = await call('dev.test', {
      ...args,
      recipe: {
        id: 'runtime-smoke',
        title: 'Upload a file and extract a document',
        inputs: { file: { type: 'attachment' } },
        steps: [
          { op: 'navigate', path: '/files/runtime-smoke.html' },
          { op: 'attach', selector: '#file', input: 'file' },
          { op: 'assert', selector: '#output', text: 'example.txt:Hello' },
          { op: 'document', selector: 'article', as: 'document' },
        ],
      },
      inputs: { file: { name: 'example.txt', mimeType: 'text/plain', base64: 'SGVsbG8=' } },
    });
    assert.deepEqual(outputs.document, {
      kind: 'markdown',
      name: 'Smoke document',
      markdown: '# Document title\n\nExample body',
    });
    assert.equal(await target.locator('#output').textContent(), 'example.txt:Hello');
  } finally {
    await target.unroute(url);
  }
}
