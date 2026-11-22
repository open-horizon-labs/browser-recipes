// Chromium serializes this function into the isolated world of the selected document.
export async function executeDom({ origin, op, selector, input, text, match, documentPaths, attributes = [] }) {
  const fail = code => ({ ok: false, code });
  const success = value => ({ ok: true, value });
  if (location.origin !== origin) return fail('ORIGIN_CHANGED');

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible') return false;
    return element.getClientRects().length > 0 ||
      (['read', 'readList', 'assert'].includes(op) && style.display === 'contents' &&
        [...element.children].some(child => child.getClientRects().length > 0 &&
          getComputedStyle(child).visibility === 'visible'));
  }

  function clean(value, limit) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function safePath(href, includeFragment = false) {
    if (!href) return undefined;
    try {
      const url = new URL(href, document.baseURI);
      if (url.origin !== origin || url.username || url.password) return undefined;
      // Strip query data, including queries embedded in SPA fragment routes.
      const fragment = includeFragment ? url.hash.split(/[?&]/, 1)[0] : '';
      return `${url.pathname}${fragment}`;
    } catch {
      return undefined;
    }
  }

  function structuralSelector(element) {
    const parts = [];
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      const siblings = [...current.parentElement.children].filter(sibling => sibling.localName === current.localName);
      parts.unshift(`${CSS.escape(current.localName)}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return ['body', ...parts].join(' > ');
  }

  function credential(element) {
    const hint = `${element.autocomplete ?? ''} ${element.name ?? ''} ${element.id ?? ''}`;
    return element.matches('input[type="password"], input[type="hidden"]') ||
      /password|passwd|one-time-code|otp|sec(?:urity)?[-_ ]?code|cc[-_]|credit[-_ ]?card/i.test(hint);
  }

  function labelOf(element, attributeName) {
    if (attributeName === 'label') {
      return element.getAttribute('aria-label') ??
        [...(element.labels ?? [])].map(label => label.textContent).join(' ');
    }
    return attributeName ? element.getAttribute(attributeName) : element.innerText;
  }

  if (op === 'inspect') {
    const controls = [];
    const candidates = document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],h1,h2,h3,[contenteditable]');
    for (const element of candidates) {
      if (!visible(element) || credential(element)) continue;
      const label = element.getAttribute('aria-label') ??
        (element.labels ? [...element.labels].map(label => label.innerText).join(' ') : '');
      const path = element.matches('a[href]') ? safePath(element.href, true)?.slice(0, 1024) : undefined;
      controls.push({
        selector: structuralSelector(element),
        tag: element.localName,
        label: clean(label || (!element.matches('input,select,textarea,[contenteditable]') ? element.innerText : ''), 120),
        ...(path ? { path } : {}),
        ...(element.matches('input') ? { type: element.type } : {}),
      });
      if (controls.length === 100) break;
    }
    return success({ origin, controls });
  }


  let element;
  let observedTarget = false;
  const deadline = Date.now() + 3500;
  const isValueControl = target => target.matches('input:not([type=file]),select,textarea') && !credential(target);
  try {
    for (;;) {
      const candidates = document.querySelectorAll(selector);
      const matches = match ? [...candidates].filter(candidate => visible(candidate) &&
        !credential(candidate) && (!candidate.matches('input,textarea,select,[contenteditable]') || match.attribute || match.within) &&
        clean(match.within ? candidate.closest(match.within)?.innerText : labelOf(candidate, match.attribute), 131072)
          === clean(match.text, 16384))
        : candidates;
      if (op === 'readList') {
        const rows = [];
        for (const item of matches) {
          if (!visible(item)) continue;
          const checkbox = item.matches('input[type="checkbox"]');
          if (credential(item) || (!checkbox && item.closest('input,select,textarea,[contenteditable]'))) {
            return fail('UNSUPPORTED_CONTROL');
          }
          const renderedText = checkbox ? '' : item.innerText.trim();
          const values = Object.fromEntries(attributes.flatMap(name => {
            const value = name === 'checked' && checkbox ? String(item.checked) : labelOf(item, name);
            return value === null ? [] : [[name, value]];
          }));
          if (rows.length === 500 || renderedText.length > 4096 || Object.values(values).some(value => value.length > 4096)) {
            return fail('OUTPUT_TOO_LARGE');
          }
          rows.push({ text: renderedText, attributes: values });
        }
        return success(rows);
      }
      if (op === 'assertValues') {
        const controls = [...matches].filter(visible);
        if (!controls.every(isValueControl)) return fail('UNSUPPORTED_CONTROL');
        return JSON.stringify(controls.map(control => control.value)) === JSON.stringify(JSON.parse(input))
          ? success() : fail('ASSERTION_FAILED');
      }
      if (matches.length > 1) return fail('AMBIGUOUS_TARGET');
      element = matches[0];
      if (element && (visible(element) || (op === 'attach' && element.matches('input[type="file"]')))) {
        observedTarget = true;
        if (credential(element)) return fail('UNSUPPORTED_CONTROL');
        if (op === 'assertValue') {
          if (!isValueControl(element)) return fail('UNSUPPORTED_CONTROL');
          if (element.value === input) return success();
        } else {
          if (op !== 'assert' || text === undefined) break;
          if (element.closest('input,select,textarea,[contenteditable]')) return fail('UNSUPPORTED_CONTROL');
          if (clean(element.innerText, 131072).includes(clean(text, 1024))) return success();
        }
      }
      if (Date.now() >= deadline) return fail(observedTarget ? 'ASSERTION_FAILED' : 'TARGET_UNAVAILABLE');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch {
    return fail('INVALID_SELECTOR');
  }
  if (op === 'readValue') {
    if (!element.matches('input[readonly]:not([type=file]),textarea[readonly]')) return fail('UNSUPPORTED_CONTROL');
    return element.value.length <= 131072 ? success(element.value) : fail('OUTPUT_TOO_LARGE');
  }
  if (op === 'read' || op === 'assert') {
    if (op === 'assert') return success();
    if (element.closest('input,select,textarea,[contenteditable]')) return fail('UNSUPPORTED_CONTROL');
    const value = element.innerText.trim();
    return value.length <= 131072 ? success(value) : fail('OUTPUT_TOO_LARGE');
  }

  if (op === 'document') {
    const path = location.pathname;
    if (/%(?:25|2e|2f|5c|00)/i.test(path) || !documentPaths.some(allowed => allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed)) {
      return fail('PATH_NOT_ALLOWED');
    }
    if (element.closest('input,select,textarea,[contenteditable]')) return fail('UNSUPPORTED_CONTROL');
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script,style,template,form,input,textarea,select,[contenteditable],[hidden]').forEach(node => node.remove());
    const headings = 'h1,h2,h3,h4,h5,h6';
    const contentElements = [clone, ...clone.querySelectorAll(`article,section,p,li,pre,${headings}`)];
    for (const heading of contentElements.filter(node => node.matches(headings))) {
      heading.prepend(`${'#'.repeat(Number(heading.localName.slice(1)))} `);
    }
    for (const item of clone.querySelectorAll('li')) item.prepend('- ');
    for (const section of contentElements.slice(1)) {
      section.after(document.createTextNode('\n\n'));
    }
    for (const lineBreak of clone.querySelectorAll('br')) lineBreak.replaceWith('\n');
    const markdown = clone.textContent.trim().replace(/\n{3,}/g, '\n\n');
    return markdown.length <= 131072
      ? success({ kind: 'markdown', name: clean(document.title, 120) || 'Document', markdown })
      : fail('OUTPUT_TOO_LARGE');
  }

  if (op === 'readAttachment') {
    if (!(element instanceof HTMLAnchorElement) || !safePath(element.href)) return fail('UNSUPPORTED_CONTROL');
    return success({
      pageUrl: location.href,
      href: element.href,
      name: element.getAttribute('download') || undefined,
    });
  }

  if (element.matches(':disabled,[aria-disabled="true"]')) return fail('CONTROL_DISABLED');

  if (op === 'click') {
    const link = element.closest('a[href]');
    if (link && (!safePath(link.href) || link.hasAttribute('download') ||
      (link.target && link.target !== '_self') || (!link.target && document.querySelector('base[target]:not([target="_self"])')))) {
      return fail('UNSUPPORTED_NAVIGATION');
    }
    const submit = element.closest('button[type="submit"],button:not([type]),input[type="submit"],input[type="image"]');
    if (submit?.form) {
      const form = submit.form;
      const action = submit.hasAttribute('formaction') ? submit.formAction : form.action;
      const target = submit.hasAttribute('formtarget') ? submit.formTarget : form.target;
      if (!safePath(action) || (target && target !== '_self') ||
        (!target && document.querySelector('base[target]:not([target="_self"])'))) {
        return fail('UNSUPPORTED_NAVIGATION');
      }
    }
    element.click();
    return success();
  }

  if (op === 'fill') {
    if (element.readOnly) return fail('UNSUPPORTED_CONTROL');
    const prototypes = [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement];
    const type = prototypes.find(constructor => element instanceof constructor);
    if (!type || (type === HTMLInputElement &&
      !['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'time', 'month', 'week'].includes(element.type))) {
      return fail('UNSUPPORTED_CONTROL');
    }
    Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(element, input);
    if (element.value !== input) return fail('VALUE_REJECTED');
  } else if (op === 'attach') {
    if (!(element instanceof HTMLInputElement) || element.type !== 'file') return fail('UNSUPPORTED_CONTROL');
    const bytes = Uint8Array.from(atob(input.base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], input.name, { type: input.mimeType }));
    element.files = transfer.files;
  }

  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return success();
}
