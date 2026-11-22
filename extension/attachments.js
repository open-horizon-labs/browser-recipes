import { convertAttachment } from './attachment-convert.js'

const MAX_BYTES = 8 * 1024 * 1024

export async function readAttachment(browser, tabId, request) {
  const { pageUrl, href, name, allowedPathPrefix } = request
  await assertTab(browser, tabId, request.topUrl ?? pageUrl)

  let result
  try {
    const frames = await browser.scripting.executeScript({
      target: request.target ?? { tabId },
      func: injectAttachment,
      args: [{ pageUrl, href, allowedPathPrefix, maxBytes: MAX_BYTES }],
    })
    result = frames[0]?.result
  } catch {
    throw attachmentError('download-failed')
  }
  if (!result?.ok) throw attachmentError(result?.code || 'download-failed')
  await assertTab(browser, tabId, request.topUrl ?? pageUrl)

  const bytes = Uint8Array.from(atob(result.base64), character => character.charCodeAt(0))
  const fileName = String(name || result.name || 'document').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180)
  return convertAttachment({ name: fileName, bytes, mimeType: result.mimeType })
}

async function assertTab(browser, tabId, pageUrl) {
  const tab = await browser.tabs.get(tabId).catch(() => null)
  if (tab?.url !== pageUrl) throw attachmentError('tab-changed')
}

function attachmentError(code) {
  return Object.assign(new Error(code), { code })
}

// Chrome serializes this function for execution in the selected tab.
export async function injectAttachment({ pageUrl, href, allowedPathPrefix, maxBytes }) {
  const fail = code => ({ ok: false, code })
  if (location.href !== pageUrl) return fail('tab-changed')
  try {
    const page = new URL(pageUrl)
    const destination = new URL(href, page)
    if (!/^https?:$/.test(page.protocol) ||
        destination.origin !== page.origin || destination.username || destination.password ||
        typeof allowedPathPrefix !== 'string' || !/^\/(?!\/)[^?#\\]+$/.test(allowedPathPrefix) ||
        new URL(allowedPathPrefix, page).pathname !== allowedPathPrefix ||
        /%|\/\.\.?(?:\/|$)/.test(allowedPathPrefix) ||
        /%(?:25|2e|2f|5c|00)/i.test(destination.pathname)) {
      return fail('out-of-scope')
    }
    const isAllowedPath = allowedPathPrefix.endsWith('/')
      ? destination.pathname.startsWith(allowedPathPrefix)
      : destination.pathname === allowedPathPrefix
    if (!isAllowedPath) {
      return fail('out-of-scope')
    }

    const response = await fetch(destination, {
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok || response.redirected || !response.body) return fail('download-failed')
    const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase()
    if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return fail('download-failed')
    const reader = response.body.getReader()
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await reader.cancel()
      return fail('file-too-large')
    }

    let size = 0
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return fail('file-too-large')
      }
      for (let offset = 0; offset < value.length; offset += 16_384) {
        chunks.push(String.fromCharCode(...value.subarray(offset, offset + 16_384)))
      }
    }
    if (location.href !== pageUrl) return fail('tab-changed')
    if (!size) return fail('download-failed')
    return {
      ok: true,
      base64: btoa(chunks.join('')),
      mimeType,
      name: destination.pathname.split('/').pop(),
    }
  } catch {
    return fail('download-failed')
  }
}
