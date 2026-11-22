import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { readAttachment } from '../extension/attachments.js'
import { convertAttachment } from '../extension/attachment-convert.js'

const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const convert = (name, bytes) => convertAttachment({ name, bytes, mimeType: 'application/octet-stream' })

function archive(parts) {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(value)])))
}

test('reads Word paragraphs and returns the original image-only document', async () => {
  const document = content => archive({
    'word/document.xml': '<w:document xmlns:w="urn:word"><w:body>' + content + '</w:body></w:document>',
  })
  const text = document('<w:p><w:r><w:t>First</w:t><w:t> &amp; second</w:t></w:r></w:p><w:p><w:r><w:t>Third</w:t></w:r></w:p>')
  assert.deepEqual(await convert('letter.docx', text), {
    kind: 'markdown', name: 'letter.docx', markdown: 'First \\& second\n\nThird',
  })
  const image = document('<w:p><w:drawing/></w:p>')
  assert.deepEqual((await convert('scan.docx', image)).bytes, image)
})

test('uses workbook relationship order, shared strings, and sparse positions', async () => {
  const bytes = archive({
    'xl/workbook.xml': '<workbook xmlns:r="' + relNs + '"><sheets><sheet name="Plan" r:id="first"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="first" Target="worksheets/alternate.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><r><t>One</t></r><r><t> | two</t></r></si></sst>',
    'xl/worksheets/alternate.xml': '<worksheet><sheetData><row><c r="B2" t="s"><v>0</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>',
  })
  assert.equal((await convert('budget.xlsx', bytes)).markdown, '## Plan\n\n| A | B | C |\n| --- | --- | --- |\n|  | One \\| two | 42 |')
})

test('uses PowerPoint presentation order', async () => {
  const bytes = archive({
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:ppt" xmlns:r="' + relNs + '"><p:sldId r:id="second"/><p:sldId r:id="first"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:ppt" xmlns:a="urn:drawing"><a:p><a:t>Second</a:t></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:ppt" xmlns:a="urn:drawing"><a:p><a:t>First</a:t></a:p></p:sld>',
  })
  assert.equal((await convert('deck.pptx', bytes)).markdown, '## Slide 1\n\nFirst\n\n## Slide 2\n\nSecond')
})

function pdf(content) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ]
  let file = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = file.length
    file += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'
    return String(offset).padStart(10, '0') + ' 00000 n \n'
  })
  return strToU8(file + 'xref\n0 6\n0000000000 65535 f \n' + offsets.join('') +
    'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' + file.length + '\n%%EOF\n')
}

test('converts PDF text locally and retains PDFs without text', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => { throw new Error('unexpected network request') }
  try {
    assert.equal((await convert('notes.pdf', pdf('BT /F1 12 Tf 72 400 Td (Hello PDF) Tj ET'))).markdown, '## Page 1\n\nHello PDF')
    const scan = pdf('0 0 100 100 re f')
    assert.deepEqual((await convert('scan.pdf', scan)).bytes, scan)
  } finally {
    globalThis.fetch = original
  }
})

test('controls session, redirect, path, and stream size in the selected tab', async t => {
  const pageUrl = 'https://example.test/app'
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://example.test/documents/file.png')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.redirect, 'error')
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
  })
  const previousLocation = globalThis.location
  globalThis.location = { href: pageUrl }
  t.after(() => {
    if (previousLocation) globalThis.location = previousLocation
    else delete globalThis.location
  })
  const browser = {
    tabs: { get: async id => {
      assert.equal(id, 42)
      return { url: pageUrl }
    } },
    scripting: { executeScript: async ({ target, func, args }) => {
      assert.deepEqual(target, { tabId: 42 })
      // Recreate the serialization boundary used by Chrome.
      const isolated = Function('return (' + func.toString() + ')')()
      return [{ result: await isolated(...args) }]
    } },
  }
  const request = { pageUrl, href: '/documents/file.png', allowedPathPrefix: '/documents/' }
  const result = await readAttachment(browser, 42, request)
  assert.deepEqual(result, { kind: 'file', mimeType: 'image/png', name: 'file.png', bytes: new Uint8Array([137, 80, 78, 71]) })
  for (const href of ['https://other.test/documents/a', '/documents-sibling/a', '/documents/%2f..%2fprivate/a']) {
    await assert.rejects(readAttachment(browser, 42, { ...request, href }), { code: 'out-of-scope' })
  }
  await assert.rejects(readAttachment(browser, 42, {
    ...request, allowedPathPrefix: '/documents/file.png', href: '/documents/file.png/nested',
  }), { code: 'out-of-scope' })
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal((await readAttachment(browser, 42, {
    ...request, allowedPathPrefix: '/documents/file.png',
  })).kind, 'file')
  globalThis.location.href = 'https://example.test/changed'
  await assert.rejects(readAttachment(browser, 42, request), { code: 'tab-changed' })
  globalThis.location.href = pageUrl

  fetch.mock.mockImplementation(async () => Object.defineProperty(new Response('moved'), 'redirected', { value: true }))
  await assert.rejects(readAttachment(browser, 42, request), { code: 'download-failed' })
  fetch.mock.mockImplementation(async () => new Response(new Uint8Array(9 * 1024 * 1024)))
  await assert.rejects(readAttachment(browser, 42, request), { code: 'file-too-large' })
})

test('falls back when Office XML includes a DTD or exceeds the extraction budget', async () => {
  const dtd = archive({ 'word/document.xml': '<!DOCTYPE doc [<!ENTITY x "no">]><doc><p><t>&x;</t></p></doc>' })
  assert.equal((await convert('dtd.docx', dtd)).kind, 'file')
  const large = archive({ 'word/document.xml': '<doc><p><t>' + 'a'.repeat(13 * 1024 * 1024) + '</t></p></doc>' })
  assert.equal((await convert('large.docx', large)).kind, 'file')
})

test('counts actual expanded XML when ZIP metadata understates it', async () => {
  const prefix = '<doc><p><t>Visible text</t></p></doc>'
  const bytes = archive({ 'word/document.xml': prefix + ' '.repeat(13 * 1024 * 1024) })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  view.setUint32(22, prefix.length, true)
  for (let offset = 30; offset < bytes.length - 24; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, prefix.length, true)
      break
    }
  }
  assert.equal((await convert('understated.docx', bytes)).kind, 'file')
})
