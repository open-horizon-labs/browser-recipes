import { Unzip, UnzipInflate } from 'fflate'
import { SaxesParser } from 'saxes'

const MAX_XML_BYTES = 12 * 1024 * 1024
const ZIP_INPUT_CHUNK = 1024
const MAX_XML_PARTS = 1500
const MAX_XML_NODES = 200_000
const MAX_MARKDOWN = 500_000
const MAX_PAGES = 300
const pdfSignature = new TextEncoder().encode('%PDF-')

export async function convertAttachment({ name, bytes, mimeType }) {
  const fallback = { kind: 'file', name, mimeType, bytes }
  const prefix = bytes.subarray(0, 1024)
  const isPdf = prefix.some((_, offset) => pdfSignature.every((byte, index) => prefix[offset + index] === byte))
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  try {
    const markdown = isPdf ? await pdfMarkdown(Uint8Array.from(bytes)) : isZip ? officeMarkdown(bytes) : ''
    return markdown.trim() && markdown.length <= MAX_MARKDOWN
      ? { kind: 'markdown', name, markdown: markdown.trim() }
      : fallback
  } catch {
    return fallback
  }
}

async function pdfMarkdown(bytes) {
  const { WorkerMessageHandler } = await import('pdfjs-dist/build/pdf.worker.mjs')
  globalThis.pdfjsWorker ??= { WorkerMessageHandler }
  const { getDocument } = await import('pdfjs-dist/build/pdf.mjs')
  const runtime = globalThis.chrome?.runtime
  const task = getDocument({
    cMapUrl: runtime?.getURL('cmaps/'),
    standardFontDataUrl: runtime?.getURL('standard_fonts/'),
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    isEvalSupported: false,
  })
  try {
    const pdf = await task.promise
    if (pdf.numPages > MAX_PAGES) return ''
    const pages = []
    let length = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const reader = page.streamTextContent().getReader()
      let content = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          for (const item of value.items) {
            if (item.str === undefined) continue
            content += markdownText(item.str) + (item.hasEOL ? '\n' : '')
            if (length + content.length > MAX_MARKDOWN) return ''
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
        page.cleanup()
      }
      content = content.trim()
      if (content) {
        const section = '## Page ' + pageNumber + '\n\n' + content
        length += section.length + 2
        if (length > MAX_MARKDOWN) return ''
        pages.push(section)
      }
    }
    return pages.join('\n\n')
  } finally {
    await task.destroy()
  }
}

const textPart = /^(?:word\/document\.xml|xl\/(?:workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)|ppt\/(?:presentation\.xml|slides\/[^/]+\.xml|_rels\/presentation\.xml\.rels))$/

function extractTextParts(bytes) {
  const files = Object.create(null)
  const seen = new Set()
  let inflatedBytes = 0
  const zip = new Unzip(file => {
    if (!textPart.test(file.name)) return
    if (seen.has(file.name) || seen.size >= MAX_XML_PARTS) throw new Error('office-parts')
    seen.add(file.name)
    if (file.originalSize > MAX_XML_BYTES - inflatedBytes) throw new Error('office-text-too-large')
    const chunks = []
    let partLength = 0
    file.ondata = (error, chunk, final) => {
      if (error) throw error
      inflatedBytes += chunk.length
      if (inflatedBytes > MAX_XML_BYTES) throw new Error('office-text-too-large')
      partLength += chunk.length
      if (chunk.length) chunks.push(chunk)
      if (!final) return
      if (file.originalSize !== undefined && partLength !== file.originalSize) throw new Error('office-size-mismatch')
      const part = new Uint8Array(partLength)
      let offset = 0
      for (const bytes of chunks) {
        part.set(bytes, offset)
        offset += bytes.length
      }
      files[file.name] = part
    }
    file.start()
  })
  zip.register(UnzipInflate)
  // Feed compressed bytes in small increments so each decompression step is bounded.
  for (let offset = 0; offset < bytes.length; offset += ZIP_INPUT_CHUNK) {
    zip.push(bytes.subarray(offset, offset + ZIP_INPUT_CHUNK), offset + ZIP_INPUT_CHUNK >= bytes.length)
  }
  return files
}

function officeMarkdown(bytes) {
  const files = extractTextParts(bytes)
  if (files['word/document.xml']) {
    return paragraphs(xml(files['word/document.xml']), 'p', 't').join('\n\n')
  }
  if (files['xl/workbook.xml']) return excelMarkdown(files)
  if (files['ppt/presentation.xml']) return slidesMarkdown(files)
  return ''
}

function xml(bytes) {
  const root = { children: [] }
  const stack = [root]
  let nodes = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw new Error('office-doctype') })
  parser.on('opentag', tag => {
    if (stack.length >= 80 || ++nodes > MAX_XML_NODES) throw new Error('office-xml-complexity')
    const node = { name: tag.local, attributes: tag.attributes, children: [] }
    stack.at(-1).children.push(node)
    stack.push(node)
  })
  parser.on('closetag', () => stack.pop())
  parser.on('text', text => stack.at(-1).children.push(text))
  parser.on('cdata', text => stack.at(-1).children.push(text))
  parser.write(new TextDecoder().decode(bytes)).close()
  return root
}

function descendants(node, name) {
  const result = []
  function visit(node) {
    if (typeof node === 'string') return
    if (node.name === name) result.push(node)
    for (const child of node.children) visit(child)
  }
  visit(node)
  return result
}

function nodeText(node) {
  if (typeof node === 'string') return node
  return node?.children.map(nodeText).join('') ?? ''
}

function value(node, name) {
  return node.attributes[name]?.value
}

function relationshipId(node) {
  return Object.values(node.attributes).find(attribute =>
    attribute.local === 'id' && attribute.uri.endsWith('/relationships')
  )?.value
}

function relationships(files, path, folder) {
  const parts = files[path] ? descendants(xml(files[path]), 'Relationship') : []
  return new Map(parts.flatMap(part => {
    const target = value(part, 'Target')
    if (!target || value(part, 'TargetMode')?.toLowerCase() === 'external') return []
    const url = new URL(target, 'https://document.invalid/' + folder + '/')
    if (url.origin !== 'https://document.invalid' || !url.pathname.startsWith('/' + folder + '/')) return []
    return [[value(part, 'Id'), url.pathname.slice(1)]]
  }))
}

function paragraphs(root, paragraphName, textName) {
  return descendants(root, paragraphName).map(paragraph =>
    descendants(paragraph, textName).map(nodeText).join('')
  ).filter(text => text.trim()).map(markdownText)
}

function markdownText(text) {
  return text.replace(/[\\\u0060*_{}[\]()<>#+.!|~&-]/g, '\\$&')
}

function excelMarkdown(files) {
  const workbook = xml(files['xl/workbook.xml'])
  const parts = relationships(files, 'xl/_rels/workbook.xml.rels', 'xl')
  const shared = files['xl/sharedStrings.xml']
    ? descendants(xml(files['xl/sharedStrings.xml']), 'si').map(node =>
      descendants(node, 't').map(nodeText).join('')
    )
    : []
  const sheets = []
  for (const sheet of descendants(workbook, 'sheet')) {
    const data = files[parts.get(relationshipId(sheet))]
    if (!data) continue
    const rows = descendants(xml(data), 'row').map(row => {
      const cells = []
      for (const cell of descendants(row, 'c')) {
        const type = value(cell, 't')
        const raw = nodeText(descendants(cell, 'v')[0])
        let text = raw
        if (type === 's') text = shared[Number(raw)] ?? ''
        if (type === 'inlineStr') text = descendants(cell, 't').map(nodeText).join('')
        if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE'
        const letters = value(cell, 'r')?.match(/^[A-Z]{1,3}/)?.[0]
        const index = letters ? [...letters].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0) - 1 : cells.length
        if (index >= 256) throw new Error('office-sheet-width')
        cells[index] = markdownText(text).replace(/\r\n?|\n/g, ' ')
      }
      return cells
    }).filter(row => row.some(value => value.trim()))
    if (!rows.length) continue
    const columns = rows.reduce((width, row) => Math.max(width, row.length), 0)
    if (rows.length * columns > MAX_MARKDOWN / 3) throw new Error('office-sheet-size')
    const header = Array.from({ length: columns }, (_, index) => columnLabel(index))
    const separator = Array(columns).fill('---')
    const line = row => '| ' + Array.from({ length: columns }, (_, index) => row[index] ?? '').join(' | ') + ' |'
    const heading = '## ' + markdownText(value(sheet, 'name') || 'Worksheet').replace(/\r\n?|\n/g, ' ')
    sheets.push([heading, '', line(header), line(separator), ...rows.map(line)].join('\n'))
  }
  return sheets.join('\n\n')
}

function columnLabel(index) {
  const letter = String.fromCharCode(65 + index % 26)
  return index < 26 ? letter : columnLabel(Math.floor(index / 26) - 1) + letter
}

function slidesMarkdown(files) {
  const presentation = xml(files['ppt/presentation.xml'])
  const parts = relationships(files, 'ppt/_rels/presentation.xml.rels', 'ppt')
  return descendants(presentation, 'sldId').flatMap((slide, index) => {
    const data = files[parts.get(relationshipId(slide))]
    if (!data) return []
    const text = paragraphs(xml(data), 'p', 't')
    return text.length ? ['## Slide ' + (index + 1) + '\n\n' + text.join('\n\n')] : []
  }).join('\n\n')
}
