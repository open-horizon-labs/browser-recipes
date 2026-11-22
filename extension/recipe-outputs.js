export function renderRecipeOutputs(outputs, output, downloadUrls) {
  for (const [name, value] of Object.entries(outputs)) {
    const heading = document.createElement('h3');
    heading.textContent = name[0]?.toUpperCase() + name.slice(1).replaceAll('-',' ');
    output.append(heading);
    if (value?.kind === 'file') {
      const bytes = Uint8Array.from(atob(value.base64), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
      downloadUrls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = value.name;
      link.textContent = `Download ${value.name}`;
      output.append(link);
    } else if (Array.isArray(value) && value.every(row => typeof row?.text === 'string' &&
        row.attributes && Object.keys(row.attributes).every(key => key === 'href'))) {
      if (!value.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No items found.';
        output.append(empty);
        continue;
      }
      const list = document.createElement('ul');
      list.className = 'result-rows';
      for (const row of value) {
        const item = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = row.text;
        item.append(text);
        if (typeof row.attributes.href === 'string' && /^https?:\/\//i.test(row.attributes.href)) {
          const link = document.createElement('a');
          link.href = row.attributes.href;
          link.textContent = 'Open link';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          item.append(link);
        }
        list.append(item);
      }
      output.append(list);
    } else {
      const text = document.createElement('pre');
      text.textContent = value?.kind === 'markdown'
        ? value.markdown
        : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      output.append(text);
    }
  }
}
